declare module "pbkdf2/browser.js" {
  const pbkdf2Module: {
    pbkdf2(
      password: string | Uint8Array,
      salt: string | Uint8Array,
      iterations: number,
      keylen: number,
      digest: string,
      callback: (err: Error | null, derivedKey: Buffer) => void,
    ): void;
    pbkdf2Sync(
      password: string | Uint8Array,
      salt: string | Uint8Array,
      iterations: number,
      keylen: number,
      digest: string,
    ): Buffer;
  };

  export default pbkdf2Module;
}
