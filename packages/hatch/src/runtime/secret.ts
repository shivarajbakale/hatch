export function secretEnvVar(name: string): string {
  return `HATCH_SECRET_${name}`;
}

const NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * Reads a secret set with `hatch secrets set NAME value`.
 *
 * Secrets live in SSM Parameter Store (SecureString). `hatch deploy` copies the ones your code
 * references into the revision's environment, which Lambda encrypts at rest. Under `hatch dev`
 * they come from `.env` (as NAME=value).
 */
export function secret(name: string): string {
  if (!NAME.test(name)) throw new Error(`secret name "${name}" must be UPPER_SNAKE_CASE`);
  const value = process.env[secretEnvVar(name)] ?? process.env[name];
  if (value === undefined) {
    throw new Error(`secret ${name} is not set. Run: hatch secrets set ${name} <value>`);
  }
  return value;
}
