import { useCallback, useEffect, useRef, useState } from "react";

interface UseOverlaySpeechOptions {
  onResult?: (text: string) => void;
  onError?: (message: string) => void;
  lang?: string;
}

/** Overlay 语音输入 — Web Speech API */
export function useOverlaySpeech({ onResult, onError, lang = "zh-CN" }: UseOverlaySpeechOptions = {}) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  const supported = typeof window !== "undefined" &&
    !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
    setInterim("");
  }, []);

  const start = useCallback(() => {
    if (!supported) {
      onError?.("当前环境不支持语音识别");
      return;
    }

    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) return;

    stop();
    const recognition = new Ctor();
    recognition.lang = lang;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let text = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        text += event.results[i][0]?.transcript ?? "";
      }
      const trimmed = text.trim();
      if (!trimmed) return;

      if (event.results[event.results.length - 1]?.isFinal) {
        setInterim("");
        onResult?.(trimmed);
        stop();
      } else {
        setInterim(trimmed);
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === "aborted") return;
      onError?.(event.error === "not-allowed" ? "请允许麦克风权限" : "语音识别失败");
      stop();
    };

    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };

    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }, [lang, onError, onResult, stop, supported]);

  useEffect(() => () => stop(), [stop]);

  return { supported, listening, interim, start, stop };
}
