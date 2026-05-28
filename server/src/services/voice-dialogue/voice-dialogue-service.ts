import type {
  VoiceDialogueProvider,
  ASRProvider,
  TTSProvider,
  LLMProvider,
  AudioBuffer,
  ASRResult,
  LLMMessage,
  DialogueContext,
} from "./types.js";

export class VoiceDialogueService {
  private providers: Map<string, VoiceDialogueProvider> = new Map();
  private defaultProviderName: string | null = null;

  registerProvider(name: string, provider: VoiceDialogueProvider): void {
    this.providers.set(name, provider);
    if (!this.defaultProviderName) {
      this.defaultProviderName = name;
    }
  }

  setDefaultProvider(name: string): void {
    if (!this.providers.has(name)) {
      throw new Error(`Provider "${name}" not registered`);
    }
    this.defaultProviderName = name;
  }

  getProvider(name?: string): VoiceDialogueProvider {
    const providerName = name ?? this.defaultProviderName;
    if (!providerName) {
      throw new Error("No voice dialogue provider available");
    }
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Provider "${providerName}" not found`);
    }
    return provider;
  }

  getAvailableProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  async transcribeAudio(
    audio: AudioBuffer,
    options?: { language?: string; providerName?: string },
  ): Promise<ASRResult> {
    const provider = this.getProvider(options?.providerName);
    return provider.asr.transcribe(audio, options);
  }

  async synthesizeSpeech(
    text: string,
    options?: {
      voiceId?: string;
      speed?: number;
      pitch?: number;
      volume?: number;
      providerName?: string;
    },
  ): Promise<AudioBuffer> {
    const provider = this.getProvider(options?.providerName);
    return provider.tts.synthesize(text, options);
  }

  async chatCompletion(
    messages: LLMMessage[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      systemPrompt?: string;
      providerName?: string;
    },
  ): Promise<string> {
    const provider = this.getProvider(options?.providerName);
    return provider.llm.chat(messages, options);
  }

  async processVoiceInput(
    audio: AudioBuffer,
    context: DialogueContext,
    options?: {
      language?: string;
      systemPrompt?: string;
      temperature?: number;
      voiceId?: string;
      speed?: number;
      providerName?: string;
    },
  ): Promise<{
    userInput: ASRResult;
    llmResponse: string;
    responseAudio: AudioBuffer;
  }> {
    const provider = this.getProvider(options?.providerName);

    const userInput = await provider.asr.transcribe(audio, {
      language: options?.language,
    });

    if (!userInput.text.trim()) {
      throw new Error("No speech detected in audio input");
    }

    context.conversationHistory.push({
      role: "user",
      content: userInput.text,
    });

    const llmResponse = await provider.llm.chat(context.conversationHistory, {
      temperature: options?.temperature,
      systemPrompt: options?.systemPrompt,
    });

    context.conversationHistory.push({
      role: "assistant",
      content: llmResponse,
    });

    const responseAudio = await provider.tts.synthesize(llmResponse, {
      voiceId: options?.voiceId,
      speed: options?.speed,
    });

    return {
      userInput,
      llmResponse,
      responseAudio,
    };
  }

  async generateAndSpeak(
    text: string,
    options?: {
      voiceId?: string;
      speed?: number;
      volume?: number;
      providerName?: string;
    },
  ): Promise<AudioBuffer> {
    return this.synthesizeSpeech(text, options);
  }
}
