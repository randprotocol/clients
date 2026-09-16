# The JNI entry point is resolved by name from librand_wallet.so.
-keep class org.randprotocol.wallet.core.NativeCore { *; }
-keepclasseswithmembernames class * { native <methods>; }

# security-crypto pulls Tink, which references JSR-305 annotations that are not on the classpath.
-dontwarn javax.annotation.**
-dontwarn com.google.errorprone.annotations.**
