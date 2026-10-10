declare module "*evidence-pack.mjs" {
  export const PUBLIC_REDACTED_EXCERPT: "Content withheld by public safety policy.";
  export function hasUnsafePublicText(value: unknown): boolean;
  export function publicTextContainsPrivateIdentity(value: unknown, privateValue: unknown): boolean;
  export function sanitizeInjectableText(value: unknown, maxChars?: number): string | null;
}
