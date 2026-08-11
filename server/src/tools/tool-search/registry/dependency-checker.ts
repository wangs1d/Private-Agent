/**
 * Phase-1 Task 1.4: Skill 循环依赖检测器
 *
 * 基于 DFS 三色标记法(Depth-First Search with 3-color marking)检测 Skill 依赖图中是否存在环。
 * 当新 Skill 注册时,将其依赖链路与已注册 Skill 的依赖图合并后做深度优先遍历,
 * 若在遍历过程中遇到"正在访问中(GRAY)"的节点,则说明存在循环依赖,直接拒绝注册。
 *
 * 设计说明:
 * - 本文件为 Phase-1 的独立可并行任务,仅依赖模型接口(无项目内 import),
 *   避免与并行开发的 registry/models.ts 产生循环等待。
 * - 所有类型在本文件内本地定义,不 import models.ts。
 * - ESM 风格;本文件不依赖项目内其他模块,故无 import 语句。
 */

// ============================================================================
// 类型定义(本地定义,不 import models.ts)
// ============================================================================

/**
 * 依赖关系节点:一个待注册资源及其声明的依赖列表。
 */
export type DependencyNode = {
  resource_id: string;
  dependencies: string[]; // 依赖的 resource_id 列表
};

/**
 * 循环依赖检测结果(判别联合类型)。
 * - ok=true:未检测到环,cycle 为 null
 * - ok=false:检测到环,cycle 为环上的 resource_id 序列(首尾相同以闭合环),
 *             error_code 固定为 CIRCULAR_DEPENDENCY_DETECTED
 */
export type DependencyCheckResult =
  | { ok: true; cycle: null }
  | {
      ok: false;
      cycle: string[];
      error_code: "CIRCULAR_DEPENDENCY_DETECTED";
      error_message: string;
    };

/**
 * 依赖解析器:给定 resource_id,返回该资源已注册的依赖列表。
 * - 返回 string[]:该资源存在,其依赖为返回值
 * - 返回 null:该资源尚未注册(视为叶子节点,无下游依赖)
 *
 * 由调用方(通常是 RegistryStore)提供实现,本检测器通过它读取已存在的依赖图。
 */
export type DependencyResolver = (resourceId: string) => Promise<string[] | null>;

// ============================================================================
// DFS 三色标记常量
// ============================================================================

/** WHITE(0):尚未访问 */
const WHITE = 0;
/** GRAY(1):正在访问(位于当前 DFS 路径栈上) */
const GRAY = 1;
/** BLACK(2):已完成访问(已确认从该节点出发无环) */
const BLACK = 2;

// ============================================================================
// 内部:通用 DFS 环检测核心
// ============================================================================

/**
 * 通用 DFS 三色标记环检测核心。
 *
 * 算法步骤(对每个起始节点):
 *  1. 将节点标记为 GRAY,压入当前路径栈
 *  2. 通过 getDeps 取出该节点的依赖列表:
 *     - 返回 null → 视为叶子节点(尚未注册),标记 BLACK 并回溯
 *  3. 遍历每个依赖:
 *     - 依赖为 GRAY  → 命中环!从路径栈中截取环上节点序列(首尾闭合)并返回
 *     - 依赖为 BLACK → 已确认无环,跳过
 *     - 依赖为 WHITE → 递归 DFS
 *  4. 所有依赖处理完毕,将节点标记为 BLACK,弹出路径栈,返回 null(无环)
 *
 * 三色标记的关键性质:
 * - GRAY 节点代表"当前递归调用栈上尚未返回的节点",即处于活跃 DFS 路径上。
 *   一旦某条出边指向 GRAY 节点,说明存在"回到祖先"的回边,即环。
 * - BLACK 节点代表"已完整探索且确认无环",再次遇到无需重复遍历,保证复杂度为 O(V+E)。
 *
 * @param startNodes  DFS 的起始节点列表(批量场景可传多个)
 * @param getDeps     依赖获取函数(返回 null 表示叶子节点)
 * @returns 检测到的环上的 resource_id 序列(首尾相同以闭合);未检测到环返回 null
 */
async function runDfs(
  startNodes: string[],
  getDeps: (resourceId: string) => Promise<string[] | null>,
): Promise<string[] | null> {
  // color:节点访问状态(WHITE/GRAY/BLACK)。未在 Map 中的节点默认按 WHITE 处理。
  const color = new Map<string, number>();
  // path:当前 DFS 路径栈,用于在发现环时回溯收集环上节点。
  const path: string[] = [];

  /**
   * 递归 DFS 单个节点。返回环序列或 null。
   */
  async function dfs(nodeId: string): Promise<string[] | null> {
    // 进入节点:标记 GRAY,压入路径栈
    color.set(nodeId, GRAY);
    path.push(nodeId);

    // 获取该节点的依赖列表(null 表示叶子节点)
    const deps = await getDeps(nodeId);

    if (deps !== null) {
      // 遍历每一条出边(依赖)
      for (const dep of deps) {
        const depColor = color.get(dep) ?? WHITE;

        if (depColor === GRAY) {
          // 命中环:依赖节点已在当前路径上(回边)。
          // 从路径栈中定位该依赖节点首次出现位置,截取到栈顶,再追加该节点本身以闭合环。
          // 例:路径 = [A, B, C],当前 C 依赖 A(GRAY),
          //     截取得 [A, B, C],追加 A → [A, B, C, A]
          const cycleStart = path.indexOf(dep);
          const cycle = path.slice(cycleStart).concat(dep);
          return cycle;
        }

        if (depColor === BLACK) {
          // 已确认无环,跳过(剪枝)
          continue;
        }

        // WHITE:递归访问
        const subCycle = await dfs(dep);
        if (subCycle !== null) {
          // 下层发现了环,直接向上传播
          return subCycle;
        }
      }
    }
    // deps === null:视为叶子节点(尚未注册的资源),无下游依赖,不可能成环

    // 离开节点:标记 BLACK,弹出路径栈
    color.set(nodeId, BLACK);
    path.pop();
    return null;
  }

  // 对每个起始节点做 DFS(已访问过的跳过,避免重复遍历)
  for (const start of startNodes) {
    if ((color.get(start) ?? WHITE) === WHITE) {
      const cycle = await dfs(start);
      if (cycle !== null) {
        return cycle;
      }
    }
  }

  return null;
}

/**
 * 将环序列格式化为错误信息字符串。
 * 例:["A", "B", "C", "A"] → "Circular dependency detected: A -> B -> C -> A"
 */
function formatCycleMessage(cycle: string[]): string {
  return `Circular dependency detected: ${cycle.join(" -> ")}`;
}

/**
 * 将环序列转换为 DependencyCheckResult(失败结果)。
 */
function toFailureResult(cycle: string[]): DependencyCheckResult {
  return {
    ok: false,
    cycle,
    error_code: "CIRCULAR_DEPENDENCY_DETECTED",
    error_message: formatCycleMessage(cycle),
  };
}

// ============================================================================
// 导出:单资源检测
// ============================================================================

/**
 * 检测待注册资源是否会形成循环依赖。
 *
 * 流程:
 *  1. 将 newResourceId 及其 newDependencies 作为临时节点加入依赖图
 *  2. 从 newResourceId 出发执行 DFS 三色标记
 *  3. 若发现环 → 返回 ok=false(含环序列与错误信息),调用方应拒绝注册
 *     若未发现环 → 返回 ok=true,允许注册
 *
 * 自环检测:newDependencies 中若包含 newResourceId 自身,会被识别为
 *           [newResourceId, newResourceId] 的环并拒绝注册。
 *
 * 降级策略:若 resolver 抛出异常(无法读取已存在依赖图),
 * 记录 console.warn 告警后返回 ok=true(不阻塞注册,但留下告警痕迹)。
 *
 * @param newResourceId    待注册资源 id
 * @param newDependencies  待注册资源声明的依赖列表
 * @param resolver         已存在资源的依赖解析器(查询 store);未注册资源返回 null
 * @returns 检测结果
 */
export async function checkCircularDependency(
  newResourceId: string,
  newDependencies: string[],
  resolver: DependencyResolver,
): Promise<DependencyCheckResult> {
  try {
    // 依赖获取函数:对"待注册资源"使用其声明的依赖;对其余资源查询 resolver。
    // 注意:待注册资源尚未写入 store,若交给 resolver 会返回 null,故需优先短路。
    const getDeps = async (resourceId: string): Promise<string[] | null> => {
      if (resourceId === newResourceId) {
        return newDependencies;
      }
      return resolver(resourceId);
    };

    const cycle = await runDfs([newResourceId], getDeps);
    if (cycle !== null) {
      return toFailureResult(cycle);
    }
    return { ok: true, cycle: null };
  } catch (err) {
    // 降级:resolver 抛错等异常情况,不阻塞注册,仅告警
    console.warn(
      "[dependency-checker] checkCircularDependency 降级为通过(resolver 异常):",
      err,
    );
    return { ok: true, cycle: null };
  }
}

// ============================================================================
// 导出:批量检测
// ============================================================================

/**
 * 批量检测:对多个待注册资源一起检测(适合批量注册场景)。
 *
 * 流程:
 *  1. 将所有新节点一次性加入临时依赖图(newNodesMap)
 *  2. 对每个新节点做 DFS(已访问过的跳过)
 *  3. 任一新节点出发检测到环 → 立即返回失败结果
 *     全部检测完毕无环 → 返回 ok=true
 *
 * 注意:新节点之间可能相互依赖,因此必须先把所有新节点加入图再检测,
 * 否则会出现"依赖尚未加入的兄弟节点"被误判为叶子(null)的问题。
 *
 * 降级策略同 checkCircularDependency。
 *
 * @param newNodes  待注册资源节点列表
 * @param resolver  已存在资源的依赖解析器
 * @returns 检测结果
 */
export async function checkCircularDependencyBatch(
  newNodes: DependencyNode[],
  resolver: DependencyResolver,
): Promise<DependencyCheckResult> {
  try {
    // 构建新节点依赖映射(同一 resource_id 取首次出现,避免重复定义互相覆盖)
    const newNodesMap = new Map<string, string[]>();
    for (const node of newNodes) {
      if (!newNodesMap.has(node.resource_id)) {
        newNodesMap.set(node.resource_id, node.dependencies);
      }
    }

    // 依赖获取函数:新节点查 newNodesMap;其余资源查 resolver
    const getDeps = async (resourceId: string): Promise<string[] | null> => {
      if (newNodesMap.has(resourceId)) {
        return newNodesMap.get(resourceId) ?? null;
      }
      return resolver(resourceId);
    };

    const startNodes = newNodes.map((n) => n.resource_id);
    const cycle = await runDfs(startNodes, getDeps);
    if (cycle !== null) {
      return toFailureResult(cycle);
    }
    return { ok: true, cycle: null };
  } catch (err) {
    // 降级:resolver 抛错等异常情况,不阻塞注册,仅告警
    console.warn(
      "[dependency-checker] checkCircularDependencyBatch 降级为通过(resolver 异常):",
      err,
    );
    return { ok: true, cycle: null };
  }
}
