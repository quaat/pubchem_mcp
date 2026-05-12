import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PROPERTIES,
  SUPPORTED_PROPERTIES,
  isSupportedProperty,
  validateProperties,
} from '../../../src/pubchem/propertyRegistry.js';
import { PubChemValidationError } from '../../../src/pubchem/pubchemErrors.js';

describe('propertyRegistry', () => {
  it('exposes the default property set within the supported list', () => {
    for (const p of DEFAULT_PROPERTIES) {
      expect(SUPPORTED_PROPERTIES).toContain(p);
    }
  });

  it('isSupportedProperty narrows correctly', () => {
    expect(isSupportedProperty('MolecularWeight')).toBe(true);
    expect(isSupportedProperty('NotAThing')).toBe(false);
  });

  it('validateProperties dedupes and preserves order', () => {
    const out = validateProperties(['XLogP', 'MolecularWeight', 'XLogP']);
    expect(out).toEqual(['XLogP', 'MolecularWeight']);
  });

  it('validateProperties throws PubChemValidationError with the supported list', () => {
    try {
      validateProperties(['LethalDose', 'MolecularWeight']);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PubChemValidationError);
      const ve = err as PubChemValidationError;
      expect(ve.category).toBe('validation');
      expect(ve.retryable).toBe(false);
      expect(ve.message).toMatch(/LethalDose/);
      expect(ve.message).toMatch(/Supported names:/);
    }
  });

  it('rejects empty strings as a validation error', () => {
    expect(() => validateProperties([''])).toThrow(PubChemValidationError);
  });
});
