const ts = require('typescript');
const fs = require('fs');

const file = 'src/App.tsx';
const content = fs.readFileSync(file, 'utf8');

const sourceFile = ts.createSourceFile(
  'App.tsx',
  content,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);

const componentsToExtract = [
  'ArchitectView', 'ConnectionsTab', 'TerminalPane', 'OverviewTab', 'IdentityTab', 
  'PersonalityTab', 'PermissionsTab', 'MemoryTab', 'SpendTab', 'ActivityTab', 'ChatTab',
  'ArchiveView', 'UserProfileView', 'DiagnosticsView', 'CanopyView', 'TopNav'
];

const results = {};

function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) {
    const name = node.name.text;
    if (componentsToExtract.includes(name)) {
      results[name] = {
        start: node.getFullStart(),
        end: node.getEnd(),
        text: node.getFullText(sourceFile)
      };
    }
  }
  ts.forEachChild(node, visit);
}

visit(sourceFile);

fs.writeFileSync('extracted_components.json', JSON.stringify(results, null, 2));
console.log(`Extracted ${Object.keys(results).length} components`);
for (const [k, v] of Object.entries(results)) {
    console.log(k, v.start, v.end);
}
