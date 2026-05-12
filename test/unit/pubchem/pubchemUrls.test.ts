import { describe, it, expect } from 'vitest';
import {
  buildAssaySummaryUrl,
  buildCompoundAidsUrl,
  buildCompoundByCidPropertyUrl,
  buildCompoundByInchiKeyCidsUrl,
  buildCompoundByNameCidsUrl,
  buildCompoundBySmilesCidsUrl,
  buildCompoundFullRecordUrl,
  buildCompoundSdfUrl,
  buildCompoundSynonymsUrl,
  buildListKeyPollUrl,
  buildPugViewCompoundUrl,
  buildStructureSearchUrl,
  publicAssayUrl,
  publicCompoundUrl,
  shouldUseSmilesPost,
} from '../../../src/pubchem/pubchemUrls.js';

const cfg = {
  baseUrl: 'https://pubchem.ncbi.nlm.nih.gov/rest/pug',
  viewBaseUrl: 'https://pubchem.ncbi.nlm.nih.gov/rest/pug_view',
};

describe('pubchemUrls', () => {
  it('builds property URLs for single and batch CIDs', () => {
    expect(buildCompoundByCidPropertyUrl(cfg, [2244], ['MolecularWeight'])).toBe(
      'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/2244/property/MolecularWeight/JSON',
    );
    expect(
      buildCompoundByCidPropertyUrl(cfg, [2244, 5793], ['MolecularFormula', 'XLogP']),
    ).toBe(
      'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/2244,5793/property/MolecularFormula,XLogP/JSON',
    );
  });

  it('rejects empty inputs', () => {
    expect(() => buildCompoundByCidPropertyUrl(cfg, [], ['MolecularWeight'])).toThrow();
    expect(() => buildCompoundByCidPropertyUrl(cfg, [1], [])).toThrow();
  });

  it('URL-encodes name/SMILES/InChIKey inputs', () => {
    expect(buildCompoundByNameCidsUrl(cfg, 'acetylsalicylic acid')).toContain(
      'acetylsalicylic%20acid',
    );
    expect(buildCompoundBySmilesCidsUrl(cfg, 'CC(=O)Oc1ccccc1C(=O)O')).toContain('CC(%3D');
    expect(buildCompoundByInchiKeyCidsUrl(cfg, 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N')).toBe(
      'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/inchikey/BSYNRYMUTXBXSQ-UHFFFAOYSA-N/cids/JSON',
    );
  });

  it('builds SDF urls with optional record_type', () => {
    expect(buildCompoundSdfUrl(cfg, 2244)).toBe(
      'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/2244/SDF',
    );
    expect(buildCompoundSdfUrl(cfg, 2244, '3d')).toBe(
      'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/2244/SDF?record_type=3d',
    );
  });

  it('builds full record, synonyms, aids and assay summary urls', () => {
    expect(buildCompoundFullRecordUrl(cfg, 2244)).toContain('/compound/cid/2244/JSON');
    expect(buildCompoundSynonymsUrl(cfg, 2244)).toContain('/compound/cid/2244/synonyms/JSON');
    expect(buildCompoundAidsUrl(cfg, 2244)).toContain('/compound/cid/2244/aids/JSON');
    expect(buildAssaySummaryUrl(cfg, 1259357)).toContain('/assay/aid/1259357/summary/JSON');
  });

  it('builds structure search urls with the correct operation prefix', () => {
    const ident = buildStructureSearchUrl(cfg, {
      queryType: 'smiles',
      searchType: 'identity',
      query: 'CCO',
    });
    expect(ident).toContain('/compound/fastidentity/smiles/');

    const sim = buildStructureSearchUrl(cfg, {
      queryType: 'smiles',
      searchType: 'similarity_2d',
      query: 'CCO',
      threshold: 90,
      maxRecords: 25,
    });
    expect(sim).toContain('/compound/fastsimilarity_2d/smiles/CCO/cids/JSON');
    expect(sim).toContain('Threshold=90');
    expect(sim).toContain('MaxRecords=25');

    const sub = buildStructureSearchUrl(cfg, {
      queryType: 'smiles',
      searchType: 'substructure',
      query: 'c1ccccc1',
      preferFast: false,
    });
    expect(sub).toContain('/compound/substructure/smiles/');
    expect(sub).not.toContain('fastsubstructure');
  });

  it('builds list-key polling url', () => {
    expect(buildListKeyPollUrl(cfg, 'abc-123')).toBe(
      'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/listkey/abc-123/cids/JSON',
    );
  });

  it('builds PUG-View URL with optional heading', () => {
    expect(buildPugViewCompoundUrl(cfg, 2244)).toBe(
      'https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/2244/JSON',
    );
    expect(buildPugViewCompoundUrl(cfg, 2244, 'Experimental Properties')).toContain(
      'heading=Experimental+Properties',
    );
  });

  it('shouldUseSmilesPost routes simple SMILES to GET and complex ones to POST', () => {
    // Simple
    expect(shouldUseSmilesPost('CCO')).toBe(false);
    expect(shouldUseSmilesPost('CC(=O)O')).toBe(false);
    expect(shouldUseSmilesPost('c1ccccc1')).toBe(false);
    // Risky characters
    expect(shouldUseSmilesPost('C/C=C/C')).toBe(true);          // forward slash
    expect(shouldUseSmilesPost('C\\C=C\\C')).toBe(true);        // backslash
    expect(shouldUseSmilesPost('[NH4+]')).toBe(true);           // plus
    expect(shouldUseSmilesPost('C#N#C')).toBe(true);            // hash
    expect(shouldUseSmilesPost('C&C')).toBe(true);
    expect(shouldUseSmilesPost('C%10CCCCCC%10')).toBe(true);    // percent
    // Long
    const long = 'C'.repeat(300);
    expect(shouldUseSmilesPost(long)).toBe(true);
  });

  it('builds public web URLs', () => {
    expect(publicCompoundUrl(2244)).toBe('https://pubchem.ncbi.nlm.nih.gov/compound/2244');
    expect(publicAssayUrl(1259357)).toBe('https://pubchem.ncbi.nlm.nih.gov/bioassay/1259357');
  });
});
