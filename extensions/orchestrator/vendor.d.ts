declare module "proper-lockfile" {
  interface LockOptions {
    stale?: number;
    update?: number;
    retries?: number | { retries: number; minTimeout?: number; maxTimeout?: number };
    realpath?: boolean;
    lockfilePath?: string;
    onCompromised?: (err: Error) => void;
  }

  interface CheckOptions {
    stale?: number;
    realpath?: boolean;
    lockfilePath?: string;
  }

  function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
  function lockSync(file: string, options?: LockOptions): () => void;
  function unlock(file: string, options?: LockOptions): Promise<void>;
  function unlockSync(file: string, options?: LockOptions): void;
  function check(file: string, options?: CheckOptions): Promise<boolean>;
  function checkSync(file: string, options?: CheckOptions): boolean;

  export { lock, lockSync, unlock, unlockSync, check, checkSync };
  export default { lock, lockSync, unlock, unlockSync, check, checkSync };
}
