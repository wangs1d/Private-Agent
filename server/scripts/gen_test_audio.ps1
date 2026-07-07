# 用 .NET System.Speech 生成中文测试音频
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech

$outDir = "e:\ws-project\Private-Agent\data\funasr_test_audio"
if (-not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

$cases = @(
    @{ text = "你好，今天天气怎么样"; file = "case_0.wav"; label = "短句-日常问候" },
    @{ text = "我要预约明天下午三点的会议室"; file = "case_1.wav"; label = "中句-日程预约" },
    @{ text = "帮我搜索一下北京到上海的高铁票，明天早上的车次"; file = "case_2.wav"; label = "长句-复杂查询" },
    @{ text = "1加2等于3，10乘以20等于200"; file = "case_3.wav"; label = "数字识别" },
    @{ text = "I love programming in TypeScript and Python"; file = "case_4.wav"; label = "中英混合" }
)

foreach ($c in $cases) {
    $path = Join-Path $outDir $c.file
    Write-Host "[$($c.label)] 合成：$($c.text)"
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $synth.Rate = 0
    $synth.SetOutputToWaveFile($path)
    $synth.Speak($c.text)
    $synth.Dispose()
    $size = (Get-Item $path).Length
    Write-Host "  → $path ($size bytes)"
}

Write-Host "Done."
