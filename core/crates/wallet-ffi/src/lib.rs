//! The foreign entry points. Both are one function: `rand_wallet_call(method, params_json)`
//! returning a JSON string (see `wallet_core::call`), so the Swift and Java wrappers are a few
//! lines each and every rule lives in one place.

use std::ffi::{c_char, CStr, CString};

/// Call `method` with a JSON object `params`. Returns a NUL-terminated JSON string the caller
/// must release with [`rand_wallet_free`]. Never returns NULL.
///
/// # Safety
/// `method` and `params` must be valid NUL-terminated UTF-8 strings (or NULL, which is treated as
/// empty).
#[no_mangle]
pub unsafe extern "C" fn rand_wallet_call(method: *const c_char, params: *const c_char) -> *mut c_char {
    let read = |p: *const c_char| -> String {
        if p.is_null() {
            String::new()
        } else {
            CStr::from_ptr(p).to_string_lossy().into_owned()
        }
    };
    let reply = wallet_core::call(&read(method), &read(params));
    // A reply is JSON built by serde, so it never contains a NUL; fall back to an error rather
    // than unwrap across the boundary.
    CString::new(reply)
        .unwrap_or_else(|_| CString::new(r#"{"ok":false,"error":"reply contained NUL"}"#).unwrap())
        .into_raw()
}

/// Release a string returned by [`rand_wallet_call`].
///
/// # Safety
/// `s` must be a pointer returned by `rand_wallet_call` and not already freed, or NULL.
#[no_mangle]
pub unsafe extern "C" fn rand_wallet_free(s: *mut c_char) {
    if !s.is_null() {
        drop(CString::from_raw(s));
    }
}

/// The core version, as a static string.
#[no_mangle]
pub extern "C" fn rand_wallet_version() -> *const c_char {
    static V: &str = concat!(env!("CARGO_PKG_VERSION"), "\0");
    V.as_ptr() as *const c_char
}

#[cfg(target_os = "android")]
mod android {
    use jni::objects::{JClass, JString};
    use jni::sys::jstring;
    use jni::JNIEnv;

    /// `org.randprotocol.wallet.core.NativeCore.call(String method, String paramsJson)`.
    #[no_mangle]
    pub extern "system" fn Java_org_randprotocol_wallet_core_NativeCore_call<'l>(
        mut env: JNIEnv<'l>,
        _class: JClass<'l>,
        method: JString<'l>,
        params: JString<'l>,
    ) -> jstring {
        let method: String = env.get_string(&method).map(Into::into).unwrap_or_default();
        let params: String = env.get_string(&params).map(Into::into).unwrap_or_default();
        let reply = wallet_core::call(&method, &params);
        match env.new_string(reply) {
            Ok(s) => s.into_raw(),
            Err(_) => std::ptr::null_mut(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    /// Call through the C ABI the way Swift does, release the reply, and parse it.
    fn ffi(method: Option<&str>, params: Option<&str>) -> serde_json::Value {
        let m = method.map(|s| CString::new(s).unwrap());
        let p = params.map(|s| CString::new(s).unwrap());
        let mp = m.as_ref().map_or(std::ptr::null(), |c| c.as_ptr());
        let pp = p.as_ref().map_or(std::ptr::null(), |c| c.as_ptr());
        // SAFETY: both pointers are NULL or valid NUL-terminated strings that outlive the call,
        // and the reply is released exactly once.
        unsafe {
            let out = rand_wallet_call(mp, pp);
            assert!(!out.is_null(), "the reply is never NULL");
            let text = CStr::from_ptr(out).to_str().expect("utf-8 reply").to_owned();
            rand_wallet_free(out);
            serde_json::from_str(&text).expect("the reply is JSON")
        }
    }

    #[test]
    fn version_is_the_crate_version_as_a_nul_terminated_static() {
        let p = rand_wallet_version();
        assert!(!p.is_null());
        // SAFETY: the pointer is the static, NUL-terminated string `rand_wallet_version` returns.
        let v = unsafe { CStr::from_ptr(p) }.to_str().unwrap();
        assert_eq!(v, env!("CARGO_PKG_VERSION"));
        assert_eq!(rand_wallet_version(), p, "the same static every time");
    }

    #[test]
    fn a_call_returns_the_core_reply_as_json() {
        let r = ffi(Some("format_amount"), Some(r#"{"units":"1500000000"}"#));
        assert_eq!(r, serde_json::json!({ "ok": true, "value": "1.5" }));
        let r = ffi(Some("parse_amount"), Some(r#"{"text":"0.25"}"#));
        assert_eq!(r, serde_json::json!({ "ok": true, "value": "250000000" }));
    }

    #[test]
    fn a_call_is_the_same_as_wallet_core_call() {
        let direct: serde_json::Value = serde_json::from_str(&wallet_core::call("version", "{}")).unwrap();
        assert_eq!(ffi(Some("version"), Some("{}")), direct);
        assert_eq!(direct["ok"], true);
    }

    #[test]
    fn null_params_are_empty_params() {
        // `version` takes none: NULL, "" and "{}" are the same call.
        let a = ffi(Some("version"), None);
        assert_eq!(a, ffi(Some("version"), Some("")));
        assert_eq!(a, ffi(Some("version"), Some("{}")));
        assert_eq!(a["ok"], true);
    }

    #[test]
    fn a_null_method_is_an_unknown_method_not_a_crash() {
        let r = ffi(None, None);
        assert_eq!(r["ok"], false);
        assert!(r["error"].as_str().unwrap().contains("unknown method"), "{r}");
    }

    #[test]
    fn errors_cross_the_boundary_as_json() {
        let r = ffi(Some("no_such_method"), Some("{}"));
        assert_eq!(r["ok"], false);
        assert!(r["error"].as_str().unwrap().contains("no_such_method"), "{r}");
        let r = ffi(Some("format_amount"), Some("not json"));
        assert_eq!(r["ok"], false);
        assert!(r["error"].as_str().unwrap().contains("params is not JSON"), "{r}");
        let r = ffi(Some("format_amount"), Some("{}"));
        assert_eq!(r["ok"], false, "a missing parameter is an error reply");
    }

    #[test]
    fn invalid_utf8_is_replaced_not_rejected() {
        // 0xFF is not UTF-8: it reads as U+FFFD, so the method is unknown rather than UB.
        let bad = [b'a', 0xff, b'b', 0];
        // SAFETY: `bad` is NUL-terminated and outlives the call; the params pointer is NULL.
        let r = unsafe {
            let out = rand_wallet_call(bad.as_ptr() as *const c_char, std::ptr::null());
            let text = CStr::from_ptr(out).to_str().unwrap().to_owned();
            rand_wallet_free(out);
            serde_json::from_str::<serde_json::Value>(&text).unwrap()
        };
        assert_eq!(r["ok"], false);
        assert!(r["error"].as_str().unwrap().contains('\u{fffd}'), "{r}");
    }

    #[test]
    fn freeing_null_is_a_no_op() {
        // SAFETY: NULL is explicitly allowed.
        unsafe { rand_wallet_free(std::ptr::null_mut()) };
    }
}
