package org.randprotocol.wallet.rpc;

/** A JSON-RPC error from the node (with its code) or a transport failure (code 0). */
public class RpcException extends Exception {
    public final int code;
    /** The HTTP status the reply came with when it was not a success; 0 otherwise. */
    public final int httpStatus;

    public RpcException(int code, String message) {
        this(code, message, 0);
    }

    public RpcException(int code, String message, int httpStatus) {
        super(message);
        this.code = code;
        this.httpStatus = httpStatus;
    }

    public RpcException(String message, Throwable cause) {
        super(message, cause);
        this.code = 0;
        this.httpStatus = 0;
    }
}
