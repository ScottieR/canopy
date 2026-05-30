import { useForumStore } from './forumStore';

export function createForumOrchestrator(forumId: string) {
  let isRunning = true;

  const runOrchestrator = async () => {
    while (isRunning) {
      const forum = useForumStore.getState().forums.find((f: any) => f.id === forumId);
      if (!forum || !forum.active) {
        break; // Stop if forum is archived/deleted or marked inactive
      }

      try {
        // Point 1: Swapped Promise.all for Promise.allSettled for resilience
        const results = await Promise.allSettled([
          agentRizTask(),
          agentSterlingTask(),
          agentAtelierTask()
        ]);

        results.forEach((result, index) => {
          if (result.status === 'rejected') {
            console.error(`Agent task ${index} failed:`, result.reason);
            // Localized alert handled here, orchestrator continues
          } else {
             // Point 4: intercept LLM responses to tally prompt/completion tokens (mocked logic)
             // useForumStore.getState().incrementTokensAndCost(forumId, result.value.tokens, result.value.cost);
          }
        });

      } catch (err) {
        console.error("Global orchestrator error:", err);
      }
      
      // Delay to prevent tight loop
      await new Promise(res => setTimeout(res, 5000));
    }
  };

  runOrchestrator();

  return {
    stop: () => { isRunning = false; }
  };
}

// Global background listener initialization
export function initializeGlobalBackgroundOrchestrator() {
  const activeOrchestrators = new Map<string, ReturnType<typeof createForumOrchestrator>>();

  useForumStore.subscribe((state: any) => {
    state.forums.forEach((forum: any) => {
      if (forum.active && !activeOrchestrators.has(forum.id)) {
        // Start background service decoupled from UI
        const engine = createForumOrchestrator(forum.id);
        activeOrchestrators.set(forum.id, engine);
      } else if (!forum.active && activeOrchestrators.has(forum.id)) {
        // Stop engine if forum is deactivated
        activeOrchestrators.get(forum.id)?.stop();
        activeOrchestrators.delete(forum.id);
      }
    });
  });
}

// Mock tasks
async function agentRizTask() { return { tokens: 150, cost: 0.002 }; }
async function agentSterlingTask() { return { tokens: 200, cost: 0.003 }; }
async function agentAtelierTask() { return { tokens: 100, cost: 0.001 }; }
