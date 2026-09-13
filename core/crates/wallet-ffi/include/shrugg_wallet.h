// Rand Wallet core — C interface. One call, JSON in, JSON out.
//
//   char* reply = shrugg_wallet_call("wallet_info", "{\"spend_key\":\"…\"}");
//   // reply is {"ok":true,"value":{…}} or {"ok":false,"error":"…"}
//   shrugg_wallet_free(reply);
//
// Methods and their parameters are documented on `wallet_core::dispatch` (core/crates/wallet-core).
#ifndef SHRUGG_WALLET_H
#define SHRUGG_WALLET_H

#ifdef __cplusplus
extern "C" {
#endif

/// Returns a NUL-terminated JSON string; release it with shrugg_wallet_free. Never NULL.
char *shrugg_wallet_call(const char *method, const char *params_json);

/// Release a string returned by shrugg_wallet_call.
void shrugg_wallet_free(char *s);

/// The core version; static, do not free.
const char *shrugg_wallet_version(void);

#ifdef __cplusplus
}
#endif

#endif
