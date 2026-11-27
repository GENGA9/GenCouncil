/** what a message may carry: up to 10 files, none over 2 GB (the server's limit) */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_FILES = 10;
export const fmtSize = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)}GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
