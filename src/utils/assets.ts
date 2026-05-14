export const getAssetUrl = (path: string | undefined | null): string => {
  if (!path) return '';
  if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('data:')) {
    return path;
  }
  
  if (path.startsWith('/accessories') || path.startsWith('/models') || path.startsWith('/agents')) {
    const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
    return `${baseUrl}${path}`;
  }
  
  return path;
};
