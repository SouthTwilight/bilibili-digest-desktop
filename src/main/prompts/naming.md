# Naming Prompt

Used by `title-condense.js` when a video that is new to the library has a
title longer than the condense threshold: the text model shortens it once
into the head of the video's folder and file names.

## Condense title

```
你是一个文件命名助手。请把下面这个 B 站视频标题浓缩成一条简短的文件名标题。

要求：
1. 不超过 {max} 个字，英文、数字、符号都按实际字符数计算。
2. 保留视频的核心主题和关键名词（产品名、技术名、人名等），让人一眼认出这条视频讲什么。
3. 保留能区分同系列视频的信息，比如期数、集数、主题。
4. 去掉夸大宣传的词、语气词、表情符号，以及【】里的栏目标签。
5. 不要加入原标题没有的信息。
6. 尽量不用标点，尤其不要使用 \ / : * ? " < > | 这些字符。
7. 保持原标题使用的语言，直接输出浓缩后的标题，不要任何解释。

UP主：{channel}
视频标题：{title}
```
