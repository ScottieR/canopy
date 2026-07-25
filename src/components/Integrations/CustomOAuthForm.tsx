import React, { useState } from 'react';

interface CustomOAuthFormProps {
  onSuccess: () => void;
  onCancel: () => void;
}

export const CustomOAuthForm: React.FC<CustomOAuthFormProps> = ({ onSuccess, onCancel }) => {
  const [providerName, setProviderName] = useState('');
  const [authUrl, setAuthUrl] = useState('');
  const [tokenUrl, setTokenUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [scopes, setScopes] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Simulate sending configuration to the Canopy host bridge
    console.log('Registering custom OAuth provider via JIT Bridge...', {
      providerName,
      authUrl,
      tokenUrl,
      clientId,
      scopes
    });
    
    // Once registered, this would trigger the OAuth flow via the native bridge
    onSuccess();
  };

  return (
    <div className="p-6 bg-white dark:bg-slate-900 rounded-xl shadow-sm border border-slate-200 dark:border-slate-800">
      <h2 className="text-xl font-bold mb-4 text-slate-800 dark:text-slate-100">Add Custom Connection</h2>
      <p className="text-sm text-slate-600 dark:text-slate-400 mb-6">
        Configure a custom OAuth provider (e.g., Airbnb). Agents will securely use this connection without ever seeing your raw credentials.
      </p>
      
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Provider Name</label>
          <input 
            type="text" 
            value={providerName}
            onChange={(e) => setProviderName(e.target.value)}
            placeholder="e.g. Airbnb" 
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-white"
            required 
          />
        </div>
        
        <div>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Client ID</label>
          <input 
            type="text" 
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-white"
            required 
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Authorization URL</label>
          <input 
            type="url" 
            value={authUrl}
            onChange={(e) => setAuthUrl(e.target.value)}
            placeholder="https://..." 
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-white"
            required 
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Token URL</label>
          <input 
            type="url" 
            value={tokenUrl}
            onChange={(e) => setTokenUrl(e.target.value)}
            placeholder="https://..." 
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-white"
            required 
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Scopes (comma-separated)</label>
          <input 
            type="text" 
            value={scopes}
            onChange={(e) => setScopes(e.target.value)}
            placeholder="read, write" 
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-white"
          />
        </div>

        <div className="pt-4 flex justify-end space-x-3">
          <button 
            type="button" 
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700 dark:hover:bg-slate-700"
          >
            Cancel
          </button>
          <button 
            type="submit"
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700"
          >
            Authenticate
          </button>
        </div>
      </form>
    </div>
  );
};
