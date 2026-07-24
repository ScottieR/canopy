import React, { useState } from 'react';

interface AgentRecipe {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  defaultModel: string;
}

const DEFAULT_RECIPES: AgentRecipe[] = [
  {
    id: 'fusion-routing',
    name: 'Fusion Routing Orchestrator',
    description: 'Spawns multiple fast agents in parallel and synthesizes the result using a heavy model.',
    systemPrompt: 'You are an orchestrator. Dispatch tasks to subagents and combine their outputs...',
    tools: ['sessions_spawn', 'sessions_yield'],
    defaultModel: 'claude-opus-4.7'
  },
  {
    id: 'user-sim-qa',
    name: 'User-Sim QA Tester',
    description: 'Automated subagent that acts as a user to stress-test product flows.',
    systemPrompt: 'You are an end-user testing the application. Navigate flows and report UX friction...',
    tools: ['browser', 'message'],
    defaultModel: 'gemini-3.5-flash'
  },
  {
    id: 'repo-mechanic',
    name: 'Repo Mechanic',
    description: 'Watches for code changes and automatically lints, tests, and proposes refactors.',
    systemPrompt: 'You are a code mechanic. Review recent commits and ensure stability...',
    tools: ['exec', 'read', 'edit', 'git'],
    defaultModel: 'claude-haiku-4.5'
  }
];

export const AgentRecipeLibrary: React.FC = () => {
  const [importedRecipes, setImportedRecipes] = useState<string[]>([]);
  const [selectedRecipe, setSelectedRecipe] = useState<AgentRecipe | null>(null);

  const handleImport = (id: string) => {
    if (!importedRecipes.includes(id)) {
      setImportedRecipes(prev => [...prev, id]);
      // In a real app, this would dispatch to a store or API to instantiate the agent
      console.log(`Imported recipe: ${id}`);
    }
  };

  return (
    <div className="p-6 bg-white dark:bg-slate-900 rounded-xl shadow-sm border border-slate-200 dark:border-slate-800">
      <h2 className="text-2xl font-bold mb-4 text-slate-800 dark:text-slate-100">Agent Recipe Library</h2>
      <p className="text-slate-600 dark:text-slate-400 mb-6">
        Discover and one-click import pre-configured agent templates (playbooks). 
        These include system prompts, tool permissions, and default routing logic.
      </p>
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {DEFAULT_RECIPES.map(recipe => (
          <div 
            key={recipe.id} 
            className="p-4 border rounded-lg hover:border-blue-500 transition-colors bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 flex flex-col"
          >
            <h3 className="font-semibold text-lg text-slate-900 dark:text-slate-100">{recipe.name}</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-2 mb-4 flex-grow">{recipe.description}</p>
            
            <div className="mb-4 text-xs">
              <span className="font-medium text-slate-700 dark:text-slate-300">Model:</span> 
              <span className="ml-1 px-2 py-1 bg-slate-200 dark:bg-slate-700 rounded text-slate-800 dark:text-slate-200">{recipe.defaultModel}</span>
            </div>

            <button
              onClick={() => handleImport(recipe.id)}
              disabled={importedRecipes.includes(recipe.id)}
              className={`w-full py-2 px-4 rounded font-medium transition-colors ${
                importedRecipes.includes(recipe.id)
                  ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 cursor-not-allowed'
                  : 'bg-blue-600 hover:bg-blue-700 text-white shadow-sm'
              }`}
            >
              {importedRecipes.includes(recipe.id) ? 'Imported \u2713' : 'Import Recipe'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};
