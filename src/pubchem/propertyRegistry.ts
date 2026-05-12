import { PubChemValidationError } from './pubchemErrors.js';

/**
 * Allowlist of PubChem compound property names we expose. This protects
 * downstream callers from typos and protects PubChem from arbitrary
 * property strings ending up in URLs.
 *
 * Names match PubChem's documented property table identifiers exactly.
 */

export const SUPPORTED_PROPERTIES = [
  'MolecularFormula',
  'MolecularWeight',
  'CanonicalSMILES',
  'IsomericSMILES',
  'InChI',
  'InChIKey',
  'IUPACName',
  'XLogP',
  'ExactMass',
  'MonoisotopicMass',
  'TPSA',
  'Complexity',
  'Charge',
  'HBondDonorCount',
  'HBondAcceptorCount',
  'RotatableBondCount',
  'HeavyAtomCount',
  'IsotopeAtomCount',
  'AtomStereoCount',
  'DefinedAtomStereoCount',
  'UndefinedAtomStereoCount',
  'BondStereoCount',
  'DefinedBondStereoCount',
  'UndefinedBondStereoCount',
  'CovalentUnitCount',
  'Volume3D',
  'XStericQuadrupole3D',
  'YStericQuadrupole3D',
  'ZStericQuadrupole3D',
  'FeatureCount3D',
  'FeatureAcceptorCount3D',
  'FeatureDonorCount3D',
  'FeatureAnionCount3D',
  'FeatureCationCount3D',
  'FeatureRingCount3D',
  'FeatureHydrophobeCount3D',
  'ConformerModelRMSD3D',
  'EffectiveRotorCount3D',
  'ConformerCount3D',
  'Fingerprint2D',
  'Title',
] as const;

export type SupportedProperty = (typeof SUPPORTED_PROPERTIES)[number];

const SUPPORTED_SET = new Set<string>(SUPPORTED_PROPERTIES);

export const DEFAULT_PROPERTIES: SupportedProperty[] = [
  'MolecularFormula',
  'MolecularWeight',
  'CanonicalSMILES',
  'IsomericSMILES',
  'InChI',
  'InChIKey',
  'IUPACName',
  'XLogP',
  'TPSA',
  'Complexity',
  'Charge',
  'HBondDonorCount',
  'HBondAcceptorCount',
  'RotatableBondCount',
  'HeavyAtomCount',
];

export const COMPACT_PROPERTIES: SupportedProperty[] = [
  'MolecularFormula',
  'MolecularWeight',
  'CanonicalSMILES',
  'InChIKey',
  'IUPACName',
];

export function isSupportedProperty(name: string): name is SupportedProperty {
  return SUPPORTED_SET.has(name);
}

/**
 * Validate a requested property list. Returns the unique, ordered list of
 * names. Throws on any unsupported value, including the full supported list
 * for use in error messages.
 */
export function validateProperties(requested: ReadonlyArray<string>): SupportedProperty[] {
  const seen = new Set<string>();
  const result: SupportedProperty[] = [];
  const invalid: string[] = [];
  for (const name of requested) {
    if (typeof name !== 'string' || name.length === 0) {
      invalid.push(String(name));
      continue;
    }
    if (!isSupportedProperty(name)) {
      invalid.push(name);
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  if (invalid.length > 0) {
    throw new PubChemValidationError(
      `Unsupported property name(s): ${invalid.join(', ')}. Supported names: ${SUPPORTED_PROPERTIES.join(
        ', ',
      )}`,
      { endpoint: 'compound/cid/property' },
    );
  }
  return result;
}
