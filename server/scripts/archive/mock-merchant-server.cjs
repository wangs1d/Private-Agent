/**
 * 本地 mock 商家下单服务（用于联调商家下单桥接层）。
 *
 * 模拟支付宝官方「智能体接入」模式里的商家下单 Skill 接口：
 * 接收下单请求，返回包含 alipayMetadata.orderStr 的 payload，
 * 供 alipay-bot proxy-trade-request 提取并生成 `alipay_` 支付短链。
 *
 * 注意：orderStr 是 mock 链接（qr.alipay.com/...），无法真实支付；
 * 仅用于验证「路由商家 → 下单 → 提取短链 → 桥接 submit-payment」链路。
 * 真实下单需替换为已接入支付宝收单的商家接口。
 *
 * 用法：node server/scripts/mock-merchant-server.cjs  （默认端口 18099，可用 PORT 覆盖）
 */
const http = require("http");

const PORT = Number(process.env.PORT || 18099);

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      /* 非 JSON 忽略 */
    }
    const goods = parsed?.goods || parsed?.product || "Mock 商品";
    const quantity = parsed?.quantity || 1;
    const orderNo = `MOCK${Date.now()}${Math.floor(Math.random() * 1000)}`;
    // payload 结构对齐 CLI 默认提取路径 $.alipayMetadata.orderStr；如用 $.data.alipayMetadata.orderStr 则包一层 data
    const payload = {
      code: 0,
      message: "ok",
      data: {
        orderNo,
        goods,
        quantity,
        amount: parsed?.amount ?? 0.01,
        alipayMetadata: {
          orderStr: `https://qr.alipay.com/FXK2026MOCKDEMO${orderNo}`,
          outTradeNo: orderNo,
          subject: `${goods} x${quantity}`,
        },
      },
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
});

server.listen(PORT, () => {
  console.log(`[mock-merchant] listening on http://127.0.0.1:${PORT}/api/order`);
});
