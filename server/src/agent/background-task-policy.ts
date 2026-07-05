import type { SubAgentType } from "../services/master-agent-types.js";

const EXPLICIT_BACKGROUND_RE =
  /(后台|异步|先挂着|挂后台|慢慢跑|持续|一直盯着|持续监控|监控|盯盘|有结果再告诉我|完成后告诉我|好了叫我|稍后告诉我|不用等我|长时间跑|排队处理|批量处理|定时跑)/i;

const LONG_RUNNING_TASK_RE =
  /(monitor|watch|background|async|queue|batch|crawl|scrape|deploy|build|benchmark|stress|poll|持续监控|长时间|批量|多轮|轮询|抓取大量|部署|构建|压测|跑一阵|整批|自动盯着)/i;

const INTERACTIVE_OR_SHORT_RE =
  /^(你好|hello|hi|hey|谢谢|thanks|bye|再见|在吗|收到|好嘞|ok|okay)[!！。？?\s]*$/i;

const SIMPLE_INFO_RE =
  /(查一下|搜一下|看一下|解释一下|介绍一下|对比一下|翻译一下|总结一下|改写一下|帮我看看|告诉我|是什么|为什么|怎么)/i;

export function shouldAllowBackgroundSubAgentTask(params: {
  userMessage: string;
  taskDescription: string;
  agentType: SubAgentType;
  explicitlyRequested: boolean;
}): boolean {
  const userMessage = params.userMessage.trim();
  const taskDescription = params.taskDescription.trim();
  const combined = `${userMessage}\n${taskDescription}`;

  if (!params.explicitlyRequested) return false;
  if (!userMessage || !taskDescription) return false;
  if (INTERACTIVE_OR_SHORT_RE.test(userMessage)) return false;

  const explicitBackground =
    EXPLICIT_BACKGROUND_RE.test(userMessage) || EXPLICIT_BACKGROUND_RE.test(taskDescription);
  const looksLongRunning =
    LONG_RUNNING_TASK_RE.test(combined) ||
    taskDescription.length >= 80 ||
    /(?:然后|并且|同时|接着|再|之后).*(?:然后|并且|同时|接着|再|之后)/.test(taskDescription);

  if (!explicitBackground && !looksLongRunning) return false;

  if (
    params.agentType === "info" &&
    SIMPLE_INFO_RE.test(userMessage) &&
    taskDescription.length < 100 &&
    !LONG_RUNNING_TASK_RE.test(combined)
  ) {
    return false;
  }

  return true;
}
