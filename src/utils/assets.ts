export const getAssetUrl = (path: string | undefined | null): string => {
  if (!path) return '';
  if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('data:')) {
    return path;
  }
  
  if (path.startsWith('/accessories') || path.startsWith('/models') || path.startsWith('/agents')) {
    // Static 3D/image assets are served from object storage in production —
    // the full set is 3GB+, far too large for canopy-admin's own Cloud Run
    // container (or git). VITE_ASSET_BASE_URL points at that bucket.
    // VITE_API_URL stays reserved for actual API calls (habitat listings,
    // etc.), which is why these two intentionally diverge in production.
    // Falls back to VITE_API_URL so local dev (which serves both from the
    // same canopy-admin instance) needs no extra config. See GitHub issue #19.
    const baseUrl = import.meta.env.VITE_ASSET_BASE_URL || import.meta.env.VITE_API_URL || 'http://localhost:3001';
    return `${baseUrl}${path}`;
  }
  
  return path;
};
