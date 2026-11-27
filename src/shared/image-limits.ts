const MiB = 1024 * 1024;

export const imageCountLimit = 4;
export const imageSourceLimit = 10 * MiB;
export const imageUploadLimit = 5 * MiB;
export const messageImageLimit = 8 * MiB;
// Attachments saved by earlier versions did not carry a byte count.
export const legacyImageUploadLimit = 2 * MiB;

export function base64Length(bytes: number) {
  return 4 * Math.ceil(bytes / 3);
}
