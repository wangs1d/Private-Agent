import { routeDisplayEffect } from "../src/services/display-effect-router.js";

const r = routeDisplayEffect({
  title: "安装步骤",
  items: [
    { text: "第1步 下载安装包", type: "num" },
    { text: "第2步 双击运行", type: "num" },
    { text: "第3步 完成配置", type: "num" },
  ],
});
console.log("steps result:", JSON.stringify(r));

const r2 = routeDisplayEffect({
  title: "周末安排",
  items: [
    { text: "09:00 起床吃早餐" },
    { text: "10:30 健身房" },
    { text: "12:00 午饭" },
    { text: "14:00 电影" },
  ],
});
console.log("timeline result:", JSON.stringify(r2));
