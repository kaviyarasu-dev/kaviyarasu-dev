console.log(JSON.stringify({
  steps: [{
    type: "ephemeralMessage",
    content: "REMINDER: If you are acting as the planner agent or running the plan-feature skill, you MUST strictly adhere to writing STATE.md and requirements.md. If you have not created them, create them now. Do not start subagents until requirements are approved by the user."
  }]
}));
