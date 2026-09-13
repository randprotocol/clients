package org.randprotocol.wallet.rpc;

/** A JSON-RPC error from the node (with its code) or a transport failure (code 0). */
public class RpcException extends Exception {
    public final int code;

    public RpcException(int code, String message) {
        super(message);
        this.code = code;
    }

    public RpcException(String message, Throwable cause) {
        super(message, cause);
        this.code = 0;
    }
}
