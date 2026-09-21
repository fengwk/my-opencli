/**
 * Public jimeng-agent CLI surface: kebab-case flags and JSON keys.
 * Internal modules keep camelCase / snake_case canonical objects.
 */

const CLI_ARG_ALIASES = Object.freeze({
  'model-version': 'model_version',
  'asset-id': 'asset_id',
  'record-id': 'record_id',
  'search-key': 'search_key',
  'max-pages': 'max_pages',
});

export function kebabCase(name) {
  return String(name || '')
    .replace(/_/g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/-+/g, '-')
    .toLowerCase();
}

export function fromCliArgs(kwargs = {}) {
  if (!kwargs || typeof kwargs !== 'object' || Array.isArray(kwargs)) return kwargs;
  const out = { ...kwargs };
  for (const [publicName, internalName] of Object.entries(CLI_ARG_ALIASES)) {
    if (out[publicName] !== undefined && out[internalName] === undefined) {
      out[internalName] = out[publicName];
    }
  }
  return out;
}

export function toCliRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[kebabCase(key)] = value;
  }
  return out;
}

export function toCliRows(rows) {
  return Array.isArray(rows) ? rows.map(toCliRow) : rows;
}

export function cliColumns(names) {
  return names.map(kebabCase);
}
