//! JSON-RPC 2.0 over HTTP to a `shrugg-node` (fullnode `docs/rpc.md`). Blocking; only ever
//! called from the engine's worker thread.

use serde_json::{json, Value};
use std::time::Duration;

pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone)]
pub struct Rpc {
    url: String,
    agent: ureq::Agent,
}

impl Rpc {
    pub fn new(url: &str) -> Rpc {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(15))
            .timeout(Duration::from_secs(120))
            .build();
        Rpc { url: url.trim().to_string(), agent }
    }

    pub fn call(&self, method: &str, params: Value) -> Result<Value> {
        if self.url.is_empty() {
            return Err("set an RPC URL in Settings".into());
        }
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        let resp = self
            .agent
            .post(&self.url)
            .set("content-type", "application/json")
            .send_string(&body.to_string())
            .map_err(|e| match e {
                ureq::Error::Status(code, r) => {
                    let text = r.into_string().unwrap_or_default();
                    format!("node answered HTTP {code}: {}", text.chars().take(200).collect::<String>())
                }
                other => format!("cannot reach {}: {other}", self.url),
            })?;
        let v: Value = resp.into_json().map_err(|e| format!("node reply is not JSON: {e}"))?;
        if let Some(err) = v.get("error") {
            return Err(err["message"].as_str().unwrap_or("rpc error").to_string());
        }
        Ok(v.get("result").cloned().unwrap_or(Value::Null))
    }

    fn u64_of(v: &Value) -> Result<u64> {
        match v {
            Value::Number(n) => n.as_u64().ok_or_else(|| "expected an integer".into()),
            Value::String(s) => s.parse().map_err(|_| "expected an integer".to_string()),
            _ => Err("expected an integer".into()),
        }
    }

    pub fn chain_id(&self) -> Result<u64> {
        Self::u64_of(&self.call("shrugg_chainId", json!([]))?)
    }

    pub fn status(&self) -> Result<Value> {
        self.call("shrugg_status", json!([]))
    }

    pub fn head_height(&self) -> Result<u64> {
        Self::u64_of(&self.call("shrugg_getHead", json!([]))?["height"])
    }

    pub fn commitments(&self, from: u64, limit: usize) -> Result<Vec<Value>> {
        Ok(self.call("shrugg_getCommitments", json!([from, limit]))?.as_array().cloned().unwrap_or_default())
    }

    pub fn nullifiers(&self, from_height: u64, limit: usize) -> Result<Vec<(u64, String)>> {
        let rows = self.call("shrugg_getNullifiers", json!([from_height, limit]))?;
        rows.as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|r| Ok((Self::u64_of(&r["height"])?, r["nullifier"].as_str().unwrap_or("").to_string())))
            .collect()
    }

    pub fn anchor(&self) -> Result<(u64, String)> {
        let v = self.call("shrugg_getAnchor", json!([]))?;
        Ok((Self::u64_of(&v["height"])?, v["root"].as_str().unwrap_or("").to_string()))
    }

    pub fn witness(&self, index: u64) -> Result<(String, Vec<String>)> {
        let v = self.call("shrugg_getWitness", json!([index]))?;
        if v.is_null() {
            return Err(format!("no leaf at index {index}"));
        }
        let path = v["path"]
            .as_array()
            .ok_or("witness has no path")?
            .iter()
            .map(|p| p.as_str().unwrap_or("").to_string())
            .collect();
        Ok((v["root"].as_str().unwrap_or("").to_string(), path))
    }

    pub fn send_transaction(&self, hex: &str) -> Result<String> {
        self.call("shrugg_sendTransaction", json!([hex]))?
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| "node returned no transaction hash".into())
    }

    /// `None` until committed.
    pub fn transaction_height(&self, hash: &str) -> Result<Option<u64>> {
        let v = self.call("shrugg_getTransaction", json!([hash]))?;
        if v.is_null() {
            return Ok(None);
        }
        Ok(Some(Self::u64_of(&v["height"])?))
    }

    pub fn mint(&self, address: &str) -> Result<String> {
        self.call("shrugg_mint", json!([address]))?
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| "faucet returned no transaction hash".into())
    }

    pub fn bridge_enabled(&self) -> Result<bool> {
        Ok(self.call("shrugg_getBridgeState", json!([]))?["enabled"].as_bool().unwrap_or(false))
    }

    pub fn block_actions(&self, height: u64) -> Result<Vec<Value>> {
        let b = self.call("shrugg_getBlockByHeight", json!([height]))?;
        Ok(b["transactions"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|tx| tx["action"].clone())
            .collect())
    }
}
