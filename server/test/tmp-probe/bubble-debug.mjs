import { StreamSegmenter } from '../../src/agent/stream-segmenter.js';
for (const text of ['哎，在呢。有什么事？', '在吗', '嗯。好的。']) {
  const out = [];
  const seg = new StreamSegmenter((t, p, m) => out.push({ t, b: m?.bubble }), {
    pauseMs: 0, interimReplyGapMs: 0, holdFirstSentence: false,
    segmentationEnabled: true, bubbleGapMinMs: 0, bubbleGapMaxMs: 0, maxBubbles: 4,
  });
  seg.enableBubbleMode();
  seg.feed(text);
  await seg.chain;
  await seg.flushFinal();
  console.log(text, '→', JSON.stringify(out.map(o => o.t)));
}
