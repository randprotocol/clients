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
