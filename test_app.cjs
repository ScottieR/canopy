const fs = require('fs');
const ocStatus = {
  "system": {},
  "agents": {
    "entries": [
      {
        "id": "agent-boots",
        "bootstrapPending": false,
        "lastActiveAgeMs": null
      }
    ]
  }
};
const currentAgents = [ { id: "agent-boots", status: "sleeping", currentAction: "idle" } ];
let anyActive = false;

const mergedAgents = currentAgents.map(a => {
  let newStatus = a.status;
  let newAction = a.currentAction;
  
  if (!ocStatus || !ocStatus.agents || !ocStatus.agents.entries) {
      return a;
  }
  
  const agentEntry = ocStatus.agents.entries.find(e => e.id === a.id);
  
  if (!agentEntry) {
      if (a.status !== "error") {
          newStatus = "error";
      }
  } else {
      anyActive = true;
      if (agentEntry.bootstrapPending) {
          newStatus = "deploying";
          newAction = "installing dependencies...";
      } else if (agentEntry.lastActiveAgeMs === null) {
          newStatus = "sleeping";
          newAction = "idle";
      }
  }
  return { ...a, status: newStatus, currentAction: newAction };
});

console.log("anyActive:", anyActive);
console.log("mergedAgents:", mergedAgents);
