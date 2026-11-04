import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Ajv from 'ajv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema: unknown = JSON.parse(
  readFileSync(join(__dirname, 'schema.json'), 'utf-8'),
);

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema as object);

export interface SchemaError {
  path: string;
  message: string;
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: SchemaError[];
}

export function validateSchema(data: unknown): SchemaValidationResult {
  const valid = validate(data);
  if (valid) {
    return { valid: true, errors: [] };
  }
  const errors: SchemaError[] = (validate.errors || []).map((err: { dataPath?: string; schemaPath?: string; message?: string }) => ({
    path: err.dataPath || err.schemaPath || '',
    message: err.message || '',
  }));
  return { valid: false, errors };
}
