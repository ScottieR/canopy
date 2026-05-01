const fs = require('fs');
const path = '/Users/scottieryan/Documents/Claude/Projects/Agent Management/shared/agents.json';
const data = JSON.parse(fs.readFileSync(path, 'utf8'));

for (const key of Object.keys(data)) {
  const agent = data[key];
  
  if (!agent.identity_template) {
    agent.identity_template = agent.defaultPrompt || "You are a helpful assistant.";
  }
  
  if (!agent.soul_template) {
    agent.soul_template = `# {{name}}\n\n## Communication Style\n{{description}}\n\n## Additional Instructions\n{{custom_instructions}}`;
  }
}

fs.writeFileSync(path, JSON.stringify(data, null, 2));
console.log('Migrated agents.json');
