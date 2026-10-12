//! Private multisig signing (spec docs/superpowers/specs/2026-10-11-msauth-signing-design.md §2): the
//! `msauth_*` methods of [`crate::dispatch`], over fullnode's `randprotocol-msig` — the same checks
//! the `rand multisig-private` CLI makes. Pure: no I/O. A policy carries the account's `msk` and a
//! proposal its witness; neither is ever written into an error.
use crate::Result;
use randprotocol_core::notes::word8_to_hex;
use randprotocol_msig::{self as msig, Policy, Proposal};
use randprotocol_core::Keypair;
use serde_json::{json, Value};
use zeroize::Zeroizing;

fn err(e: msig::MsigError) -> String {
    e.to_string()
}

/// A pasted or opened file: a leading byte-order mark dropped, whitespace trimmed.
pub fn clean(s: &str) -> &str {
    s.strip_prefix('\u{feff}').unwrap_or(s).trim()
}

fn parse_policy(policy: &str) -> Result<Policy> {
    let p: Policy = serde_json::from_str(clean(policy)).map_err(|e| format!("the policy does not parse: {e}"))?;
    p.check().map_err(err)?;
    Ok(p)
}

/// An output a signer must name the payee of, as the crate's payee check counts them: not change,
/// and moving value (a zero-amount output is a dummy slot).
fn needs_payee(o: &msig::OutputSummary) -> bool {
    !o.to_account && o.amount != 0
}

/// Each expected-recipient entry as the caller gave it, with the owner fingerprint
/// ([`msig::owner_fingerprint_of_text`]) of its address part — the text before the last `:` when
/// what follows parses as an amount, otherwise the whole entry — or null when that does not parse
/// as an address (the crate refuses such an entry anyway). An output's `owner_fingerprint` equal
/// to an entry's `fingerprint` pays that entry.
pub fn expected_entries(expected_recipients: &[String]) -> Value {
    let rows: Vec<Value> = expected_recipients
        .iter()
        .map(|entry| {
            let text = clean(entry);
            let addr = match text.rsplit_once(':') {
                Some((a, amt)) if randprotocol_core::parse_amount(amt.trim()).is_ok() => a,
                _ => text,
            };
            json!({ "entry": entry, "fingerprint": msig::owner_fingerprint_of_text(addr).ok() })
        })
        .collect();
    Value::Array(rows)
}

/// `check_proposal_expecting`, re-shaped to this crate's wire rule (amounts as decimal strings),
/// with fullnode's `lines()` verbatim, each output's `matches` (the crate's `"<address fp>
/// (<amount> RAND)"`, or null) and `needs_payee`, the crate's `recipients_checked` (false when
/// `expected_recipients` is empty: then no payee was checked and the lines say so), `expected`
/// ([`expected_entries`]), and the chain the proposal names (`chain_id`, `genesis`,
/// `binding_domain`) for the caller's comparison with its node. `expected_recipients` are
/// `rand1…` or `rand1…:AMOUNT` texts, passed to the crate as given (it parses the amounts). A
/// proposal paying anyone else, leaving an entry unpaid or missing an amount pin is refused in the
/// crate's own sentence.
pub fn check(proposal: &str, policy: &str, expected_recipients: &[String]) -> Result<Value> {
    let (proposal, policy) = (clean(proposal), clean(policy));
    let s = msig::check_proposal_expecting(proposal, policy, expected_recipients).map_err(err)?;
    let p: Proposal = serde_json::from_str(proposal).map_err(|e| format!("the proposal does not parse: {e}"))?;
    let outputs: Vec<Value> = s
        .outputs
        .iter()
        .map(|o| json!({
            "owner_fingerprint": o.owner_fingerprint, "to_account": o.to_account, "amount": o.amount.to_string(),
            "asset": o.asset, "memo": o.memo, "matches": o.matches, "needs_payee": needs_payee(o),
        }))
        .collect();
    Ok(json!({
        "outputs": outputs,
        "recipients_checked": s.recipients_checked,
        "expected": expected_entries(expected_recipients),
        "fee": s.fee.to_string(),
        "burns": { "burn_a": s.burns.burn_a.to_string(), "burn_asset": s.burns.burn_asset, "burn_r": s.burns.burn_r.to_string() },
        "expires_at": s.expires_at,
        "signing_message": hex::encode(s.signing_message),
        "policy_fingerprint": s.policy_fingerprint,
        "lines": s.lines(),
        "chain_id": s.chain_id,
        "genesis": s.genesis,
        "binding_domain": p.binding_domain,
    }))
}

/// `verify_share`: `true`, or the refusal.
pub fn verify_share(proposal: &str, policy: &str, share: &str) -> Result<Value> {
    msig::verify_share(clean(proposal), clean(policy), clean(share)).map_err(err)?;
    Ok(Value::Bool(true))
}

/// What a signer compares out of band before saving a profile.
pub fn policy_info(policy: &str) -> Result<Value> {
    let p = parse_policy(policy)?;
    Ok(json!({
        "fingerprint": p.fingerprint(),
        "threshold": p.threshold,
        "signers": p.signers.len(),
        "address": p.address().to_string(),
        "policy_hash": word8_to_hex(&p.policy_hash()),
    }))
}

/// What a signer key looks like, when the input is neither.
pub const SIGNER_KEY_SHAPE: &str = "a signer key is a rand-node keygen file or 64 hex characters";

/// `msauth_sign`'s refusal when no payee was named but the proposal moves value to someone: the
/// core never makes a share whose payee nobody checked, whatever the caller did before.
pub const NO_PAYEE_NAMED: &str = "no expected recipient given: the payee was NOT checked";

const SEED_SHAPE: &str = "a signer seed is 64 hex characters";

/// A seed in a buffer that is wiped when dropped. The error never repeats the input.
fn seed_from_hex(s: &str) -> Result<Zeroizing<[u8; 32]>> {
    let mut seed = Zeroizing::new([0u8; 32]);
    hex::decode_to_slice(clean(s), &mut seed[..]).map_err(|_| SEED_SHAPE.to_string())?;
    Ok(seed)
}

/// A `rand-node keygen` file (`{seed, address, public_key}`) or a bare 64-hex seed: the seed, the
/// key it derives, and — given the policy — this key's position in it (refused if absent). A file
/// whose `public_key` or `address` is not its seed's is refused. No error repeats the seed.
pub fn signer_import(input: &str, policy: Option<&str>) -> Result<Value> {
    let input = clean(input);
    let (seed, claimed_pk, claimed_address) = if input.starts_with('{') {
        let v: Value = serde_json::from_str(input).map_err(|_| SIGNER_KEY_SHAPE.to_string())?;
        let s = v["seed"].as_str().ok_or(SIGNER_KEY_SHAPE)?;
        (seed_from_hex(s).map_err(|_| SIGNER_KEY_SHAPE.to_string())?, v["public_key"].as_str().map(str::to_owned), v["address"].as_str().map(str::to_owned))
    } else {
        (seed_from_hex(input).map_err(|_| SIGNER_KEY_SHAPE.to_string())?, None, None)
    };
    let kp = Keypair::from_seed(*seed).map_err(|e| format!("the signer seed: {e}"))?;
    let public_key = kp.public_key().to_hex();
    if claimed_pk.is_some_and(|c| !c.trim().eq_ignore_ascii_case(&public_key)) {
        return crate::bad("the key file's public_key is not the one its seed derives");
    }
    let address = kp.address().to_base58();
    if claimed_address.is_some_and(|a| a.trim() != address) {
        return crate::bad("the key file's address is not the one its seed derives");
    }
    let index = match policy {
        None => Value::Null,
        Some(pol) => {
            let pks = parse_policy(pol)?.pks().map_err(err)?;
            let i = pks.iter().position(|k| k[..] == kp.public_key().as_bytes()[..]).ok_or("this key is not one of the policy's signers")?;
            json!(i)
        }
    };
    Ok(json!({ "seed": hex::encode(&seed[..]), "public_key": public_key, "address": address, "index": index }))
}

/// `sign`: the share `"i:hex"`, through the crate's `sign_expecting` — every check [`check`]
/// makes, the payee check included, runs first. With `expected_recipients` empty, a proposal with
/// any paying output (not change, amount > 0) is refused ([`NO_PAYEE_NAMED`]); one paying no one
/// (all change or zero-amount slots) signs. The seed lives in a wiped buffer.
pub fn sign(proposal: &str, policy: &str, seed_hex: &str, expected_recipients: &[String]) -> Result<Value> {
    let seed = seed_from_hex(seed_hex)?;
    let (proposal, policy) = (clean(proposal), clean(policy));
    if expected_recipients.is_empty() {
        let s = msig::check_proposal_expecting::<&str>(proposal, policy, &[]).map_err(err)?;
        if s.outputs.iter().any(needs_payee) {
            return crate::bad(NO_PAYEE_NAMED);
        }
    }
    let (i, sig) = msig::sign_expecting(proposal, policy, &seed, expected_recipients).map_err(err)?;
    Ok(Value::String(format!("{i}:{}", hex::encode(sig))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../ui/test/fixtures/msauth/");
    const VENDORED: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../vendor/fullnode/crates/randprotocol-msig/tests/fixtures/");
    pub(super) fn fx(name: &str) -> String {
        std::fs::read_to_string(format!("{DIR}{name}.json")).unwrap()
    }
    pub(super) fn expected() -> Value {
        serde_json::from_str(&fx("expected")).unwrap()
    }

    /// The valid proposal's real payee: the address its informational summary names
    /// ("pay 10 RAND to rand1…", fullnode's generator). Read from there, never from the app's view.
    pub(super) fn payee() -> String {
        let p: Value = serde_json::from_str(&fx("proposal-valid")).unwrap();
        let a = p["summary"][0].as_str().unwrap().rsplit(' ').next().unwrap().to_string();
        assert_eq!(a, expected()["recipient"].as_str().unwrap(), "the generator's recipient");
        a
    }

    /// The coordinator paid its own key in the payee's slot: without a payee named the crate's
    /// checks pass (and say the payee was not checked); with the payee's real address it refuses,
    /// naming the output and the owner key it pays, in the crate's own sentence.
    #[test]
    fn a_substituted_recipient_is_refused_naming_the_output() {
        let (prop, pol) = (fx("proposal-substituted-recipient"), fx("policy"));
        let e = check(&prop, &pol, &[payee()]).unwrap_err();
        assert_eq!(e, "output 2 pays b9856a063c1fb742, not an expected recipient");
        assert_eq!(e, expected()["substituted_refusal"].as_str().unwrap());
        assert_eq!(check(&prop, &pol, &[format!("{}:10", payee())]).unwrap_err(), e, "an amount pin changes nothing");
        let plain = check(&prop, &pol, &[]).unwrap();
        assert_eq!(plain["recipients_checked"], false);
        assert_eq!(plain["outputs"][2]["owner_fingerprint"], "b9856a063c1fb742");
        assert!(plain["outputs"][2]["matches"].is_null());
        assert_eq!(plain["outputs"][2]["needs_payee"], true);
        assert_eq!(plain["lines"][1], randprotocol_msig::NO_EXPECTATION);
    }

    #[test]
    fn the_valid_proposal_matches_its_payee_and_nothing_given_checks_nothing() {
        let v = check(&fx("proposal-valid"), &fx("policy"), &[payee()]).unwrap();
        assert_eq!(v["recipients_checked"], true);
        assert_eq!(v["outputs"][2]["matches"], "A5SR-HRMB-SY4M-5ZYF (10 RAND)");
        assert!(v["lines"][3].as_str().unwrap().contains(" matches A5SR-HRMB-SY4M-5ZYF (10 RAND) "), "{}", v["lines"][3]);
        let none = check(&fx("proposal-valid"), &fx("policy"), &[]).unwrap();
        assert_eq!(none["recipients_checked"], false);
        assert!(none["outputs"].as_array().unwrap().iter().all(|o| o["matches"].is_null()));
        assert!(none["lines"].as_array().unwrap().iter().any(|l| l.as_str().unwrap().contains("no expected recipient given: the payee was NOT checked")));
        assert_eq!(none["expected"], json!([]));
        let e = check(&fx("proposal-valid"), &fx("policy"), &["rand1nope".into()]).unwrap_err();
        assert!(e.starts_with("expected recipient 0 is not a shielded address"), "{e}");
    }

    /// `rand1…:AMOUNT` pins the RAND paid; the crate parses the amount (wallet-core does not).
    #[test]
    fn an_amount_pin_is_met_exactly_or_refused() {
        let (prop, pol) = (fx("proposal-valid"), fx("policy"));
        for ok in [format!("{}:10", payee()), format!("{}:10.0", payee()), format!(" {}:10 \n", payee())] {
            assert_eq!(check(&prop, &pol, &[ok.clone()]).unwrap()["recipients_checked"], true, "{ok:?}");
        }
        assert_eq!(check(&prop, &pol, &[format!("{}:9", payee())]).unwrap_err(), "expected recipient A5SR-HRMB-SY4M-5ZYF is paid 10 RAND, not 9 RAND");
        let e = check(&prop, &pol, &[format!("{}:ten", payee())]).unwrap_err();
        assert!(e.starts_with("expected recipient 0 has a malformed amount"), "{e}");
    }

    /// `expected`: each entry as given, with the owner fingerprint of its address part (what the
    /// output lines' `owner_fingerprint` is), null when the address does not parse.
    #[test]
    fn expected_names_each_entry_with_its_owner_fingerprint() {
        let fp = expected()["recipient_owner_fingerprint"].as_str().unwrap().to_string();
        assert_eq!(fp, "35bad5bd21a6f0f7");
        let entries = [payee(), format!("{}:10", payee())];
        let v = check(&fx("proposal-valid"), &fx("policy"), &entries).unwrap();
        assert_eq!(v["expected"], json!([{ "entry": entries[0], "fingerprint": fp }, { "entry": entries[1], "fingerprint": fp }]));
        assert_eq!(v["outputs"][2]["owner_fingerprint"], json!(fp), "the row's fingerprint is the output's");
        let raw = format!(" {}:1.5\n", payee());
        assert_eq!(
            expected_entries(&[raw.clone(), "rand1nope".into(), "rand1nope:10".into(), format!("{}:nope", payee())]),
            json!([
                { "entry": raw, "fingerprint": fp },
                { "entry": "rand1nope", "fingerprint": null },
                { "entry": "rand1nope:10", "fingerprint": null },
                { "entry": format!("{}:nope", payee()), "fingerprint": null },
            ])
        );
    }

    #[test]
    fn the_fixture_copies_are_the_vendored_vectors() {
        let names = |d: &str| -> Vec<String> {
            let mut v: Vec<String> = std::fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
            v.sort();
            v
        };
        assert_eq!(names(DIR), names(VENDORED), "the same files: re-copy after a re-pin (Task 3 Step 1)");
        assert_eq!(names(VENDORED).len(), 11);
        for n in names(VENDORED) {
            assert_eq!(std::fs::read(format!("{DIR}{n}")).unwrap(), std::fs::read(format!("{VENDORED}{n}")).unwrap(), "{n}");
        }
    }

    #[test]
    fn check_returns_the_expected_summary_with_amounts_as_strings() {
        let v = check(&fx("proposal-valid"), &fx("policy"), &[payee()]).unwrap();
        let want = &expected()["summary_expecting_recipient"];
        assert_eq!(v["outputs"].as_array().unwrap().len(), 4);
        for (i, o) in want["outputs"].as_array().unwrap().iter().enumerate() {
            let got = &v["outputs"][i];
            assert_eq!(got["owner_fingerprint"], o["owner_fingerprint"]);
            assert_eq!(got["to_account"], o["to_account"]);
            assert_eq!(got["amount"], json!(o["amount"].as_u64().unwrap().to_string()), "amounts are strings");
            assert_eq!((&got["asset"], &got["memo"], &got["matches"]), (&o["asset"], &o["memo"], &o["matches"]));
            assert_eq!(got["needs_payee"], json!(!o["to_account"].as_bool().unwrap() && o["amount"].as_u64().unwrap() != 0));
        }
        assert_eq!(v["recipients_checked"], want["recipients_checked"]);
        assert_eq!(v["fee"], "1000000");
        assert_eq!(v["burns"], json!({ "burn_a": "0", "burn_asset": 0, "burn_r": "0" }));
        assert_eq!(v["expires_at"], 2024);
        assert_eq!(v["signing_message"], expected()["signing_message"]);
        assert_eq!(v["policy_fingerprint"], "NFYW-K8E9-E5K9-AAK3");
        assert_eq!((&v["chain_id"], &v["binding_domain"], &v["genesis"]), (&json!(7), &json!(0), &json!("0".repeat(64))));
        let lines = randprotocol_msig::check_proposal_expecting(&fx("proposal-valid"), &fx("policy"), &[payee()]).unwrap().lines();
        assert_eq!(v["lines"], json!(lines), "fullnode's lines, verbatim");
        assert_eq!(v["lines"], expected()["lines_expecting_recipient"]);
        assert_eq!(lines[0], format!("chain 7 · genesis {}", "0".repeat(64)));
        for l in &lines[1..5] {
            assert!(l.contains("(owner key verified; delivery key NOT verifiable from this proposal)"), "{l}");
        }
        assert!(lines[4].contains("this account 4333dd507bcc4286"), "change is labelled: {}", lines[4]);
        assert!(lines.iter().all(|l| !l.contains("rand1")), "no address from the proposal's summary");
        let none = check(&fx("proposal-valid"), &fx("policy"), &[]).unwrap();
        assert_eq!(none["lines"], expected()["lines"]);
    }

    #[test]
    fn each_bad_proposal_is_refused_by_name() {
        for (name, words) in [
            ("proposal-tampered-output", "does not open as this account's"),
            ("proposal-unbound", "does not hash to the proposal's binding"),
            ("proposal-wrong-expected", "expected digest is not its bundle's"),
            ("proposal-fee-raised", "the witness's value does not match the outputs: asset 0"),
            ("proposal-value-mismatch", "the witness's value does not match"),
            ("proposal-expired", "the proposal expires at"),
        ] {
            for given in [vec![], vec![payee()]] {
                let e = check(&fx(name), &fx("policy"), &given).unwrap_err();
                assert!(e.contains(words), "{name}: {e}");
            }
        }
    }

    #[test]
    fn a_bom_and_whitespace_around_a_file_are_tolerated() {
        assert_eq!(clean("\u{feff}  {}\r\n"), "{}");
        check(&format!("\u{feff}{}\r\n", fx("proposal-valid")), &format!("\u{feff}  {}\n", fx("policy")), &[format!(" {}\n", payee())]).unwrap();
        verify_share(&format!("\u{feff}{}", fx("proposal-valid")), &fx("policy"), &format!("{}\n", expected()["share_0"].as_str().unwrap())).unwrap();
        policy_info(&format!("\u{feff}{}\n", fx("policy"))).unwrap();
    }

    #[test]
    fn verify_share_takes_the_expected_shares_and_refuses_others() {
        let (prop, pol) = (fx("proposal-valid"), fx("policy"));
        for k in ["share_0", "share_2"] {
            assert_eq!(verify_share(&prop, &pol, expected()[k].as_str().unwrap()).unwrap(), Value::Bool(true));
        }
        let sig = expected()["share_2"].as_str().unwrap().split_once(':').unwrap().1.to_string();
        assert!(verify_share(&prop, &pol, &format!("1:{sig}")).unwrap_err().contains("signer 1's signature does not verify"));
        assert!(verify_share(&prop, &pol, &format!("7:{sig}")).unwrap_err().contains("signer 7 is not in this policy"));
        assert!(verify_share(&prop, &pol, "2:zz").unwrap_err().contains("not hex"));
    }

    #[test]
    fn policy_info_names_the_account_every_signer_compares() {
        let v = policy_info(&fx("policy")).unwrap();
        assert_eq!((&v["fingerprint"], &v["threshold"], &v["signers"]), (&json!("NFYW-K8E9-E5K9-AAK3"), &json!(2), &json!(3)));
        let prop: Value = serde_json::from_str(&fx("proposal-valid")).unwrap();
        assert_eq!(v["policy_hash"], prop["policy"], "the hash a proposal names");
        assert!(v["address"].as_str().unwrap().starts_with("rand1"));
        assert!(policy_info("{\"version\":1,\"threshold\":0,\"signers\":[],\"msk\":\"00\"}").is_err());
        assert!(policy_info("not json").unwrap_err().starts_with("the policy does not parse"));
    }

    #[test]
    fn the_dispatch_arms_answer_through_call() {
        let p = json!({ "proposal": fx("proposal-valid"), "policy": fx("policy"), "expected_recipients": [format!("{}:10", payee())] });
        let r: Value = serde_json::from_str(&crate::call("msauth_check", &p.to_string())).unwrap();
        assert_eq!(r["ok"], true, "{r}");
        assert_eq!(r["value"]["recipients_checked"], true);
        assert_eq!(r["value"]["expected"][0]["fingerprint"], "35bad5bd21a6f0f7");
        let p = json!({ "proposal": fx("proposal-valid"), "policy": fx("policy") });
        let r: Value = serde_json::from_str(&crate::call("msauth_check", &p.to_string())).unwrap();
        assert_eq!(r["value"]["recipients_checked"], false, "{r}");
        let p = json!({ "proposal": fx("proposal-substituted-recipient"), "policy": fx("policy"), "expected_recipients": [payee()] });
        let r: Value = serde_json::from_str(&crate::call("msauth_check", &p.to_string())).unwrap();
        assert_eq!((&r["ok"], &r["error"]), (&json!(false), &expected()["substituted_refusal"]), "{r}");
        let p = json!({ "proposal": fx("proposal-valid"), "policy": fx("policy"), "expected_recipients": [7] });
        let r: Value = serde_json::from_str(&crate::call("msauth_check", &p.to_string())).unwrap();
        assert_eq!((&r["ok"], &r["error"]), (&json!(false), &json!("expected_recipients must be a list of addresses")), "the sentence ui/engine/core-errors.js translates");
        let r: Value = serde_json::from_str(&crate::call("msauth_policy_info", &json!({ "policy": fx("policy") }).to_string())).unwrap();
        assert_eq!(r["value"]["threshold"], 2);
        let s = json!({ "proposal": fx("proposal-valid"), "policy": fx("policy"), "share": expected()["share_0"] });
        let r: Value = serde_json::from_str(&crate::call("msauth_verify_share", &s.to_string())).unwrap();
        assert_eq!(r["value"], true);
    }

    fn seeds() -> (Vec<String>, String) {
        let v: Value = serde_json::from_str(&fx("signer-seeds")).unwrap();
        (v["members"].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect(), v["non_member"].as_str().unwrap().to_string())
    }

    #[test]
    fn members_0_and_2_sign_the_expected_shares() {
        let (m, _) = seeds();
        for (i, want) in [(0usize, "share_0"), (2, "share_2")] {
            for given in [vec![payee()], vec![format!("{}:10", payee())]] {
                let share = sign(&fx("proposal-valid"), &fx("policy"), &m[i], &given).unwrap();
                assert_eq!(share, expected()[want], "deterministic Dilithium2 reproduces the vector");
            }
        }
    }

    #[test]
    fn an_outsider_a_bad_proposal_or_a_bad_seed_signs_nothing() {
        let (m, outsider) = seeds();
        assert!(sign(&fx("proposal-valid"), &fx("policy"), &outsider, &[payee()]).unwrap_err().contains("not one of the policy's signers"));
        assert!(sign(&fx("proposal-unbound"), &fx("policy"), &m[0], &[payee()]).unwrap_err().contains("binding"));
        for bad in ["zz", "", &m[0][..62], &format!("{}00", m[0])] {
            let e = sign(&fx("proposal-valid"), &fx("policy"), bad, &[payee()]).unwrap_err();
            assert_eq!(e, "a signer seed is 64 hex characters", "never echoes the seed");
        }
    }

    /// The core itself checks the payee: a share is never made for a proposal paying someone the
    /// signer did not name, nor for a paying proposal when no payee was named at all.
    #[test]
    fn sign_refuses_an_unnamed_or_substituted_payee() {
        let (m, _) = seeds();
        assert_eq!(sign(&fx("proposal-valid"), &fx("policy"), &m[0], &[]).unwrap_err(), NO_PAYEE_NAMED);
        assert_eq!(NO_PAYEE_NAMED, "no expected recipient given: the payee was NOT checked");
        assert_eq!(
            sign(&fx("proposal-substituted-recipient"), &fx("policy"), &m[0], &[payee()]).unwrap_err(),
            expected()["substituted_refusal"].as_str().unwrap()
        );
        assert_eq!(
            sign(&fx("proposal-valid"), &fx("policy"), &m[0], &[format!("{}:9", payee())]).unwrap_err(),
            "expected recipient A5SR-HRMB-SY4M-5ZYF is paid 10 RAND, not 9 RAND"
        );
        assert!(sign(&fx("proposal-valid"), &fx("policy"), &m[0], &["rand1nope".into()]).unwrap_err().starts_with("expected recipient 0 is not a shielded address"));
    }

    #[test]
    fn import_reads_a_keygen_file_or_bare_hex_and_finds_the_position() {
        let (m, outsider) = seeds();
        let kp = randprotocol_core::Keypair::from_seed(hex::decode(&m[2]).unwrap().try_into().unwrap()).unwrap();
        let file = json!({ "seed": m[2], "address": kp.address().to_base58(), "public_key": kp.public_key().to_hex() }).to_string();
        let v = signer_import(&file, Some(&fx("policy"))).unwrap();
        assert_eq!((&v["seed"], &v["index"], &v["public_key"]), (&json!(m[2]), &json!(2), &json!(kp.public_key().to_hex())));
        assert_eq!(v["address"], json!(kp.address().to_base58()));
        assert_eq!(signer_import(&format!("\u{feff}{file}\n"), None).unwrap()["seed"], json!(m[2]), "a BOM and whitespace are tolerated");
        assert_eq!(signer_import(&m[0], Some(&fx("policy"))).unwrap()["index"], 0);
        assert_eq!(signer_import(&format!(" {}\n", m[0]), None).unwrap()["index"], Value::Null);
        assert_eq!(signer_import(&outsider, Some(&fx("policy"))).unwrap_err(), "this key is not one of the policy's signers");
        let lying = json!({ "seed": m[2], "address": kp.address().to_base58(), "public_key": "00".repeat(1312) }).to_string();
        assert_eq!(signer_import(&lying, None).unwrap_err(), "the key file's public_key is not the one its seed derives");
        let lying = json!({ "seed": m[2], "address": "1111", "public_key": kp.public_key().to_hex() }).to_string();
        assert_eq!(signer_import(&lying, None).unwrap_err(), "the key file's address is not the one its seed derives");
        assert_eq!(signer_import("{\"spend_key\":\"aa\"}", None).unwrap_err(), SIGNER_KEY_SHAPE);
        assert_eq!(signer_import("{\"seed\":\"zz\"}", None).unwrap_err(), SIGNER_KEY_SHAPE);
        assert_eq!(signer_import("nope", None).unwrap_err(), SIGNER_KEY_SHAPE);
        assert!(!signer_import(&format!("{}zz", m[0]), None).unwrap_err().contains(&m[0][..8]), "never echoes the seed");
    }

    #[test]
    fn sign_and_import_answer_through_call() {
        let (m, _) = seeds();
        let p = json!({ "proposal": fx("proposal-valid"), "policy": fx("policy"), "seed": m[0], "expected_recipients": [format!("{}:10", payee())] });
        let r: Value = serde_json::from_str(&crate::call("msauth_sign", &p.to_string())).unwrap();
        assert_eq!(r["value"], expected()["share_0"], "{r}");
        let p = json!({ "proposal": fx("proposal-valid"), "policy": fx("policy"), "seed": m[0] });
        let r: Value = serde_json::from_str(&crate::call("msauth_sign", &p.to_string())).unwrap();
        assert_eq!((&r["ok"], &r["error"]), (&json!(false), &json!(NO_PAYEE_NAMED)), "absent is empty: refused");
        let p = json!({ "proposal": fx("proposal-valid"), "policy": fx("policy"), "seed": m[0], "expected_recipients": "rand1x" });
        let r: Value = serde_json::from_str(&crate::call("msauth_sign", &p.to_string())).unwrap();
        assert_eq!(r["error"], "expected_recipients must be a list of addresses");
        let r: Value = serde_json::from_str(&crate::call("msauth_signer_import", &json!({ "input": m[2], "policy": fx("policy") }).to_string())).unwrap();
        assert_eq!(r["value"]["index"], 2, "{r}");
        let r: Value = serde_json::from_str(&crate::call("msauth_signer_import", &json!({ "input": m[2] }).to_string())).unwrap();
        assert_eq!(r["value"]["index"], Value::Null, "{r}");
    }
}
