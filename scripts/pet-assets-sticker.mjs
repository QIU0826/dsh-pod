/**
 * 桌宠贴纸线管线（scripts/pet-assets-sticker.mjs，2026-09-07）
 *
 * 「AI 贴纸主视觉 → 去白底 → 重建白色贴纸描边 → 参数化派生六轨动态连接帧」。
 * 与 pet-assets-generate.mjs（SVG 平涂线，服务 zcode/ark/dsh/gemini）互补：
 * 贴纸线角色用文生图主视觉定形象（docs/桌宠角色生产规格.md §5 的贴纸风定稿），
 * 再以同一张主视觉为母版逐帧变换姿态/表情道具，帧间零穿帮、地平线恒定。
 *
 * 角色（提示词即美术口径，一眼认出对应 AI）：
 *   claude-girl    橙→珊瑚粉长发 · 猫头鹰羽冠/翅耳/小翅膀/橙尾羽 · 深棕吊带连体衣 ·
 *                  趴在摊开的硬皮笔记本上 · 迷你分身站羽毛上挥手 · 黄四角星+橙羽毛
 *   codex-girl     翠绿→薄荷绿短发 · 呆毛 · 白猫耳绿尖 · 绿尾白尖 · 深灰连帽卫衣 ·
 *                  趴在银色笔记本电脑上 · 终端绿代码 · 小齿轮 · 迷你分身坐终端窗口
 *   opencode-girl  深紫→靛蓝长发 · 卷呆毛 · 紫狐耳浅紫内耳 · 蓬松紫尾白尖 ·
 *                  六边形开源徽章吊饰 · 黑色短款连帽衫 · 趴在多标签页黑终端上 · >_ 牌
 *   deepseek-girl  深蓝→天蓝长发 · 卷呆毛 · 鲸鱼鳍耳 · 完整深蓝鲸尾浅蓝尾鳍 ·
 *                  腰间金环 · 深蓝吊带连体衣 · 趴在蓝色纹理厚书上（风格基准角色）
 *
 * 用法：
 *   node scripts/pet-assets-sticker.mjs --fetch [角色id...]   # 下载主视觉到临时目录
 *   node scripts/pet-assets-sticker.mjs [角色id...]           # 处理主视觉 → 帧 + pet.json
 *   POD_PET_HERO_SRC=<dir>（主视觉目录，默认 %TEMP%/dsh-pod-pet-heroes）
 *   POD_PET_ASSETS_OUT=<dir>（产物目录，默认 demo-data/pet-assets）
 *
 * 产物（直接被 frames2d 引擎加载）：
 *   <out>/<id>/<track>/<short>-pet-<track><n>.webp   六轨 21 帧（192×208 透明底）
 *   <out>/<id>/hero.webp                              贴纸主视觉（换装/定稿参考）
 *   <out>/<id>/pet.json                               显式帧表清单
 *
 * 渲染依赖：Chrome/Edge 无头（CDP canvas → image/webp），与 SVG 线同款。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'

const OUT = process.env.POD_PET_ASSETS_OUT ?? 'demo-data/pet-assets'
const SRC = process.env.POD_PET_HERO_SRC ?? join(tmpdir(), 'dsh-pod-pet-heroes')
const IMG_API = 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt='
const STYLE_TAIL =
  '。白色粗描边贴纸风格，纯白背景，高饱和平涂，可爱萌系，chibi anime sticker, ' +
  'thick white sticker outline, pure white background, flat color, kawaii, full body, square composition'

const CHARACTERS = {
  'claude-girl': {
    displayName: 'Claude 娘',
    short: 'claude',
    description:
      'Claude 专属猫头鹰娘：橙→珊瑚粉渐变长发、头顶两根猫头鹰羽冠、棕色翅状耳、背后小翅膀与蓬松橙尾羽，' +
      '深棕吊带连体衣，趴在写满笔记的硬皮本上托腮沉思；迷你分身站羽毛上挥手，黄四角星与橙羽毛环绕。',
    prompt:
      'Q版chibi二次元少女，大头小身，橙色到珊瑚粉渐变长发，发顶有两根小猫头鹰羽冠，' +
      '头侧长着棕色猫头鹰翅膀状小耳，琥珀色大圆眼半睁，慵懒托腮表情，身穿深棕色吊带连体衣，' +
      '背后有一对小巧的猫头鹰翅膀，下身是蓬松的橙色猫头鹰尾羽。角色趴在一本摊开的硬皮笔记本上，' +
      '笔记本页面写满手写笔记和羽毛笔涂鸦。旁边左上角有一个更小的Q版分身，迷你版角色站在一根羽毛上挥手。' +
      '周围散布黄色四角星和飘落的橙色羽毛装饰' + STYLE_TAIL,
    brand: { primary: '#F0784D', soft: '#FFB199', hud: '#FFB088', stars: ['#FFD23F', '#FF8A5C'] },
    hudWords: ['memo', 'read', 'memo', 'done'],
  },
  'codex-girl': {
    displayName: 'Codex 娘',
    short: 'codex',
    description:
      'Codex 专属猫娘：翠绿→薄荷绿渐变短发、一根呆毛、白色猫耳绿耳尖、绿色猫眼半睁、绿尾白尖，' +
      '深灰连帽卫衣（帽子有猫耳开孔），趴在银色笔记本电脑上，屏幕是绿色终端代码与闪烁光标，键盘散落小齿轮；' +
      '迷你分身坐在终端黑框窗口里探头，黄四角星与绿色 {};</> 符号环绕。',
    prompt:
      'Q版chibi二次元少女，大头小身，翠绿色到薄荷绿渐变短发，发顶有一根呆毛，' +
      '头侧长着白色猫耳，耳尖是绿色，翠绿色猫眼半睁，慵懒托腮表情，身穿深灰色连帽卫衣（帽子上有猫耳开孔），' +
      '身后有一条绿色猫尾，尾巴尖端是白色。角色趴在一台银色笔记本电脑上，电脑屏幕显示绿色终端代码和闪烁的光标，' +
      '键盘上散落几个小齿轮。旁边左上角有一个更小的Q版分身，迷你版角色坐在一个终端黑框窗口里探出头。' +
      '周围散布黄色四角星和绿色代码符号{};</>装饰' + STYLE_TAIL,
    brand: { primary: '#1FC16B', soft: '#86F0B8', hud: '#7BE8B0', stars: ['#FFD23F', '#34E08B'] },
    hudWords: ['{ }', '</>', '{;}', 'done'],
  },
  'opencode-girl': {
    displayName: 'OpenCode 娘',
    short: 'opencode',
    description:
      'OpenCode 专属狐娘：深紫→靛蓝渐变长发、一根卷曲呆毛、紫色狐狸耳浅紫内耳、紫罗兰大眼半睁、' +
      '蓬松紫色大尾巴白尾尖，脖子挂六边形开源徽章吊饰，黑色短款连帽衫，趴在带多个标签页的黑色终端窗口上，' +
      '紫色命令行提示符与彩色输出；迷你分身从终端弹窗探头举着 >_ 小牌，黄四角星与紫色 ~/| 符号环绕。',
    prompt:
      'Q版chibi二次元少女，大头小身，深紫色到靛蓝色渐变长发，发顶有一根卷曲呆毛，' +
      '头侧长着紫色狐狸耳，耳内是浅紫色，紫罗兰色大眼睛半睁，慵懒托腮表情，身穿黑色短款连帽衫，' +
      '身后有一条蓬松的紫色狐狸大尾巴，尾巴尖是白色，脖子上挂着一个六边形开源徽章吊饰。' +
      '角色趴在一个黑色终端窗口上，终端界面显示紫色命令行提示符和彩色代码输出，窗口边缘有多个小标签页。' +
      '旁边左上角有一个更小的Q版分身，迷你版角色从一个终端弹窗里探出头，手里举着写有大于号下划线的小牌子。' +
      '周围散布黄色四角星和紫色命令行符号装饰' + STYLE_TAIL,
    brand: { primary: '#7C5CFC', soft: '#B3A6FF', hud: '#B7A8FF', stars: ['#FFD23F', '#9B8CFF'] },
    hudWords: ['>_', '~/', '>_', 'done'],
  },
  'deepseek-girl': {
    displayName: 'DeepSeek 娘',
    short: 'deepseek',
    description:
      'DeepSeek 专属鲸娘（贴纸线风格基准）：深蓝→天蓝渐变长发、一根卷曲呆毛、鲸鱼鳍状小耳、蓝色大圆眼半睁，' +
      '深蓝吊带连体衣，下身是完整的深蓝色鲸鱼尾、浅蓝尾鳍，腰间金色环扣，趴在蓝色纹理厚书上托腮；' +
      '迷你分身趴在小鲸鱼尾上挥手，黄色四角星环绕。',
    prompt:
      'Q版chibi二次元少女，大头小身，深蓝色到天蓝色渐变长发，发顶有一根卷曲呆毛，' +
      '头侧长着鲸鱼鳍状小耳，蓝色大圆眼半睁，慵懒托腮表情，身穿深蓝色吊带连体衣，' +
      '下身不是腿而是一条完整的深蓝色鲸鱼尾，尾鳍是浅蓝色，腰部有一个金色环扣。' +
      '角色趴在一本厚书上，书本封面有蓝色纹理。旁边左上角有一个更小的Q版分身，' +
      '迷你版角色趴在小鲸鱼尾上挥手。周围散布黄色四角星装饰' + STYLE_TAIL,
    brand: { primary: '#2F7FD6', soft: '#8FD0FF', hud: '#8FC7FF', stars: ['#FFD23F', '#7FC8F8'] },
    hudWords: ['book', '...', 'book', 'done'],
  },
  'zcode-girl': {
    displayName: 'Zcode 娘',
    short: 'zcode',
    description:
      'Zcode/GLM 专属终端娘：智谱蓝渐变长发、一根呆毛、左侧终端窗口发饰，深蓝科技上衣，' +
      '趴在黑色终端窗口上（蓝色提示符与彩色输出）；迷你分身戴圆框眼镜坐在终端窗口里探头，黄四角星与蓝色 {;} >_ 符号环绕。',
    prompt:
      'Q版chibi二次元少女，大头小身，智谱蓝色渐变色长发，发顶有一根呆毛，戴圆框眼镜，' +
      '头发左侧别着一个小终端窗口发饰，慵懒托腮表情，身穿深蓝色科技感上衣。' +
      '角色趴在一个黑色终端窗口上，终端显示蓝色命令行提示符和彩色代码输出。' +
      '旁边左上角有一个更小的Q版分身，迷你版角色坐在终端窗口里探出头。' +
      '周围散布黄色四角星和蓝色代码符号装饰' + STYLE_TAIL,
    brand: { primary: '#2E6BE6', soft: '#8FC0FF', hud: '#9BC4FF', stars: ['#FFD23F', '#5C9BFF'] },
    hudWords: ['zhipu', '>_', 'glm', 'done'],
  },
  'ark-girl': {
    displayName: 'Ark 娘',
    short: 'ark',
    description:
      'Ark 专属火山娘：火山品牌蓝渐变长发、头顶一对小犄角、发顶小火山（冒熔岩），深蓝熔岩纹上衣，' +
      '趴在火山岩台座上；迷你分身坐在熔岩气泡上挥手，黄四角星与橙色火星环绕。',
    prompt:
      'Q版chibi二次元少女，大头小身，火山方舟品牌蓝色渐变长发，头顶有一对小小的犄角，' +
      '发顶上有一个冒着熔岩的小火山，慵懒托腮表情，身穿深蓝色带熔岩纹理的上衣。' +
      '角色趴在一块火山岩台座上，岩石表面有熔岩裂纹。' +
      '旁边左上角有一个更小的Q版分身，迷你版角色坐在熔岩气泡上挥手。' +
      '周围散布黄色四角星和橙色火星装饰' + STYLE_TAIL,
    brand: { primary: '#1664FF', soft: '#8FB6FF', hud: '#9CC0FF', stars: ['#FFD23F', '#FF7A3C'] },
    hudWords: ['ark', 'plan', 'Volc', 'done'],
  },
  'dsh-girl': {
    displayName: 'DSH 娘',
    short: 'dsh',
    description:
      'DSH 专属鲸群娘：青色渐变长发、鲸鱼鳍状小耳、发顶六边形光环，深青吊带连体衣，' +
      '趴在六边形数据面板上；迷你分身趴在小鲸鱼上挥手，黄四角星与青色六边形环绕。',
    prompt:
      'Q版chibi二次元少女，大头小身，青色渐变长发，头侧长着鲸鱼鳍状小耳，发顶有一个六边形光环，' +
      '慵懒托腮表情，身穿深青色吊带连体衣。角色趴在一块六边形数据面板上。' +
      '旁边左上角有一个更小的Q版分身，迷你版角色趴在一只小鲸鱼上挥手。' +
      '周围散布黄色四角星和青色小六边形装饰' + STYLE_TAIL,
    brand: { primary: '#22D3EE', soft: '#A5EFFA', hud: '#8FE9F5', stars: ['#FFD23F', '#22D3EE'] },
    hudWords: ['pod', '鲸群', 'hex', 'done'],
  },
  'gemini-girl': {
    displayName: 'Gemini 娘',
    short: 'gemini',
    description:
      'Gemini 专属星娘：蓝紫波浪长发、发顶四色四芒星发饰、紫罗兰大眼，白色星空书，' +
      '趴在摊开的星空书页上；迷你分身站在四色星上挥手，黄四角星与四色小星环绕。',
    prompt:
      'Q版chibi二次元少女，大头小身，蓝紫色波浪长发，发顶有一个四色四芒星发饰，' +
      '紫罗兰色大眼睛半睁，慵懒托腮表情，身穿白色星空图案上衣。' +
      '角色趴在一本摊开的星空书上，书页是深蓝星空。' +
      '旁边左上角有一个更小的Q版分身，迷你版角色站在一颗四色星上挥手。' +
      '周围散布黄色四角星和四色小星装饰' + STYLE_TAIL,
    brand: { primary: '#7B6CF6', soft: '#BCB2FF', hud: '#C4BAFF', stars: ['#FFD23F', '#7B6CF6'] },
    hudWords: ['gemini', 'star', '四色', 'done'],
  },
}
const CHAR_IDS = Object.keys(CHARACTERS)

// ─── 六轨动作（同一母版参数化：帧间地平线/头身比恒定 = 动态连接帧零跳动） ───────
/**
 * pose 字段（全部绕「底部中心锚点」变换，趴姿道具不挪窝）：
 *   bob  垂直偏移（正=下沉/蹲，负=跳起）  rot 旋转角（deg，正=顺时针）
 *   sx/sy 挤压拉伸（呼吸/蓄力/起跳）     hud  工作轨终端芯片文案序号
 *   motion 拖拽轨速度线档位（1/2）       stars 庆祝/待机四角星（c=品牌星色序号）
 *   sweat 汗滴（1=显式）  anger 怒气标记
 */
const TRACKS = {
  idle: {
    loop: true,
    frameMs: [420, 160, 420, 260],
    frames: [
      { bob: 0, rot: 0, sx: 1, sy: 1 },
      { bob: -2.5, rot: -1.4, sx: 1.012, sy: 1.02 }, // 吸气：微微上浮、拉高
      { bob: 0, rot: 0, sx: 1, sy: 1 },
      { bob: 1, rot: 1.4, sx: 0.992, sy: 0.99, stars: [{ x: 150, y: 34, r: 4.5, c: 0, a: 0.9 }] }, // 呼气+小星
    ],
  },
  work: {
    loop: true,
    frameMs: [200, 200, 200, 220],
    frames: [
      { bob: 0, rot: 1.6, sx: 1, sy: 1, hud: 0 },
      { bob: 1, rot: 2.6, sx: 1.004, sy: 0.998, hud: 1 }, // 前倾敲码
      { bob: 0, rot: 1.4, sx: 1, sy: 1, hud: 2 },
      { bob: -0.5, rot: 0.6, sx: 1, sy: 1.004, hud: 3 },
    ],
  },
  drag: {
    loop: true,
    frameMs: [150, 170, 150, 170],
    frames: [
      { bob: 0, rot: -7, sx: 1, sy: 1, motion: 1 },
      { bob: 3, rot: 5, sx: 1.02, sy: 0.98, motion: 1 },
      { bob: -2, rot: -5, sx: 0.99, sy: 1.01, motion: 2 },
      { bob: 2, rot: 6.5, sx: 1.02, sy: 0.98, motion: 2 },
    ],
  },
  success: {
    loop: false,
    fallback: 'idle',
    frameMs: [150, 280, 240],
    frames: [
      { bob: 6, rot: 0, sx: 1.06, sy: 0.92 }, // 蹲地蓄力
      { bob: -24, rot: -2, sx: 0.97, sy: 1.04, fs: 0.9, stars: [
        { x: 44, y: 44, r: 6, c: 0, a: 1 }, { x: 150, y: 30, r: 5, c: 1, a: 1 }, { x: 96, y: 16, r: 5, c: 0, a: 0.95 }] }, // 起跳撒星（fs=整体略缩防呆毛裁切）
      { bob: 2, rot: 0, sx: 1.01, sy: 1.01, stars: [
        { x: 52, y: 52, r: 4, c: 1, a: 0.9 }, { x: 146, y: 46, r: 4.5, c: 0, a: 1 }] }, // 落地余星
    ],
  },
  fail: {
    loop: false,
    fallback: 'idle',
    frameMs: [220, 320, 280],
    frames: [
      { bob: 3, rot: -3, sx: 1, sy: 1, sweat: 1 },
      { bob: 6, rot: -7.5, sx: 1.02, sy: 0.97, sweat: 1 }, // 蔫蔫趴下
      { bob: 4, rot: -5, sx: 1.01, sy: 0.99, sweat: 0 },
    ],
  },
  angry: {
    loop: false,
    fallback: 'idle',
    frameMs: [170, 150, 240],
    frames: [
      { bob: 0, rot: 3, sx: 1, sy: 1, anger: 1 },
      { bob: 0, rot: -3.6, sx: 1, sy: 1, anger: 1 }, // 对峙抖动
      { bob: 1.5, rot: 2.4, sx: 1.02, sy: 0.98, anger: 1 }, // 跺脚
    ],
  },
}

// ─── 贴纸主视觉 SVG（按用户提示词手工绘制的高细节 Q 版 chibi 贴纸，720×720 白底） ─
//
// 文生图 API 在无 IDE 认证的环境里只会 302 到「生成中」占位图，因此主视觉改为
// 直接按提示词绘制 SVG：每个角色 = 主形象 + 趴姿道具 + 左上角迷你分身 + 品牌装饰。
// 帧管线会洪泛去白底并按统一口径重建白色贴纸描边，这里只画内部深色线稿。
// 关键纪律：每个形状闭合描边（stroke + round join），白色/浅色部件（白猫耳、尾尖、
// 本子页、终端弹窗）必须被深色描边或彩色填充完全围住，去底时才不会被吃通。

const SKIN = '#FFE3D2'
const HX = 400 // 主角色头部中心
const HY = 292

function star4(cx, cy, r, fill, rot = 0) {
  return `<path transform="translate(${cx} ${cy}) rotate(${rot})" d="M0 ${-r} Q ${r * 0.16} ${-r * 0.16} ${r} 0 Q ${r * 0.16} ${r * 0.16} 0 ${r} Q ${-r * 0.16} ${r * 0.16} ${-r} 0 Q ${-r * 0.16} ${-r * 0.16} 0 ${-r} Z" fill="${fill}"/>`
}
function featherD(cx, cy, s, rot, fill, line) {
  return `<g transform="translate(${cx} ${cy}) rotate(${rot}) scale(${s})">
<path d="M0 -36 Q15 -12 7 30 Q0 42 -7 30 Q-15 -12 0 -36 Z" fill="${fill}" stroke="${line}" stroke-width="3" stroke-linejoin="round"/>
<path d="M0 -30 L1 26" stroke="${line}" stroke-width="2.4" stroke-linecap="round" fill="none" opacity=".65"/>
<path d="M1 -14 Q-8 -9 -10 -2 M1 -2 Q-8 5 -10 12 M1 -14 Q10 -9 11 -2 M1 -2 Q10 5 11 12" stroke="${line}" stroke-width="1.8" fill="none" opacity=".5" stroke-linecap="round"/></g>`
}
function gearD(cx, cy, r, fill) {
  const teeth = 8
  const pts = []
  for (let i = 0; i < teeth * 2; i++) {
    const rr = i % 2 === 0 ? r : r * 0.72
    const a = (i / (teeth * 2)) * Math.PI * 2
    pts.push(`${(cx + Math.cos(a) * rr).toFixed(1)},${(cy + Math.sin(a) * rr).toFixed(1)}`)
  }
  return `<polygon points="${pts.join(' ')}" fill="${fill}"/><circle cx="${cx}" cy="${cy}" r="${(r * 0.34).toFixed(1)}" fill="#FFFFFF"/>`
}
/** 眼型（四角色各异，但共用同一套贴纸语言）——tilt 为外眼角上扬角度（左右镜像）。 */
const EYE_STYLES = {
  owl: { rx: 19.5, ry: 21, tilt: 0, lidH: 12, pupil: false, wing: false }, // 猫头鹰：圆润温润
  cat: { rx: 19, ry: 19, tilt: 7, lidH: 15.5, pupil: true, wing: false }, // 猫：杏眼上扬 + 竖瞳
  fox: { rx: 18.5, ry: 18, tilt: 11, lidH: 16.5, pupil: false, wing: true }, // 狐：细长上扬 + 眼尾勾
  whale: { rx: 20.5, ry: 22.5, tilt: -3, lidH: 10.5, pupil: false, wing: false }, // 鲸：最大最圆、微微下垂
}

/** 半睁眼慵懒脸（cx/cy = 头心）：粗上眼皮盖住虹膜上 1/3，外眼角下垂 + 睫毛。 */
function faceArt(cx, cy, eye, lid, style = 'owl') {
  const S = EYE_STYLES[style] ?? EYE_STYLES.owl
  const LX = cx - 47
  const RX = cx + 47
  const EY = cy + 18
  const oneEye = (x, dir) => `
<g transform="rotate(${S.tilt * dir} ${x} ${EY})">
<ellipse cx="${x}" cy="${EY}" rx="${S.rx}" ry="${S.ry}" fill="${eye}" stroke="${lid}" stroke-width="3.5"/>
<ellipse cx="${x}" cy="${EY + 7}" rx="${(S.rx * 0.58).toFixed(1)}" ry="${(S.ry * 0.42).toFixed(1)}" fill="#FFFFFF" opacity=".22"/>
${S.pupil ? `<ellipse cx="${x}" cy="${EY + 2}" rx="4.6" ry="${(S.ry * 0.6).toFixed(1)}" fill="${lid}" opacity=".85"/>` : ''}
<path d="M${x - S.rx - 4} ${EY + 3} Q${x} ${EY - S.lidH} ${x + S.rx + 4} ${EY + 3}" stroke="${lid}" stroke-width="9.5" fill="none" stroke-linecap="round"/>
<path d="M${x + S.rx * dir + dir * 2} ${EY - 1} L${x + S.rx * dir + dir * 12} ${EY - 11}" stroke="${lid}" stroke-width="5" fill="none" stroke-linecap="round"/>
${S.wing ? `<path d="M${x + S.rx * dir + dir * 4} ${EY + 4} L${x + S.rx * dir + dir * 19} ${EY - 6}" stroke="${lid}" stroke-width="3.4" fill="none" stroke-linecap="round"/>` : ''}
<path d="M${x - S.rx - 3} ${EY + S.ry - 1} Q${x} ${EY + S.ry + 8} ${x + S.rx - 1} ${EY + S.ry - 2}" stroke="${lid}" stroke-width="3.4" fill="none" stroke-linecap="round" opacity=".75"/>
<circle cx="${x + 6}" cy="${EY + 3}" r="6.4" fill="#FFFFFF" opacity=".95"/>
<circle cx="${x - 8}" cy="${EY + 16}" r="3" fill="#FFFFFF" opacity=".6"/>
</g>`
  return `
<ellipse cx="${LX}" cy="${cy + 59}" rx="19" ry="10.5" fill="#FF9FB0" opacity=".5"/>
<ellipse cx="${RX}" cy="${cy + 59}" rx="19" ry="10.5" fill="#FF9FB0" opacity=".5"/>
${oneEye(LX, 1)}${oneEye(RX, -1)}
<ellipse cx="${cx}" cy="${cy + 69}" rx="11.5" ry="9" fill="#A84A52"/>
<ellipse cx="${cx + 1}" cy="${cy + 73}" rx="6.5" ry="3.8" fill="#F0879A"/>`
}
/** 托腮双手：袖管 + 前臂 + 拳头（下巴正下方）。 */
function armsArt(sleeve, skin = SKIN, line = '#B98A75') {
  return `
<path d="M326 492 Q336 456 352 436" stroke="${sleeve}" stroke-width="26" fill="none" stroke-linecap="round"/>
<path d="M474 492 Q464 456 448 436" stroke="${sleeve}" stroke-width="26" fill="none" stroke-linecap="round"/>
<path d="M340 470 Q346 448 354 436" stroke="${skin}" stroke-width="17" fill="none" stroke-linecap="round"/>
<path d="M460 470 Q454 448 446 436" stroke="${skin}" stroke-width="17" fill="none" stroke-linecap="round"/>
<circle cx="352" cy="430" r="23" fill="${skin}" stroke="${line}" stroke-width="3.5"/>
<circle cx="448" cy="430" r="23" fill="${skin}" stroke="${line}" stroke-width="3.5"/>
<path d="M343 422 Q350 418 358 421 M442 421 Q450 418 457 422" stroke="${line}" stroke-width="2.6" fill="none" stroke-linecap="round" opacity=".7"/>`
}
/** 长发后背（len=long 垂到道具）/短发（codex）。 */
function backHairArt(line, gradId, len) {
  if (len === 'short') {
    return `<path d="M288 212 Q286 128 400 108 Q514 128 512 212 Q540 282 518 352 Q480 330 400 330 Q320 330 282 352 Q260 282 288 212 Z" fill="url(#${gradId})" stroke="${line}" stroke-width="5" stroke-linejoin="round"/>`
  }
  return `<path d="M302 214 Q300 128 400 108 Q500 128 498 214 Q538 296 526 394 Q516 468 400 476 Q284 468 274 394 Q262 296 302 214 Z" fill="url(#${gradId})" fill-opacity=".96" stroke="${line}" stroke-width="5" stroke-linejoin="round"/>`
}
function bangsArt(line, fill, longLocks = true) {
  const locks = longLocks
    ? `<path d="M302 248 Q270 330 298 432 Q314 450 332 436 Q318 340 340 252 Z" fill="${fill}" stroke="${line}" stroke-width="4.5" stroke-linejoin="round"/>
<path d="M498 248 Q530 330 502 432 Q486 450 468 436 Q482 340 460 252 Z" fill="${fill}" stroke="${line}" stroke-width="4.5" stroke-linejoin="round"/>`
    : ''
  return `
<path d="M290 242 Q286 206 318 192 Q342 222 368 196 Q388 220 406 196 Q428 224 450 196 Q480 226 508 196 Q518 220 510 252 Q472 238 442 252 Q412 232 382 254 Q352 238 322 254 Q306 254 290 242 Z" fill="${fill}" stroke="${line}" stroke-width="5" stroke-linejoin="round"/>
${locks}`
}
function sceneWrap(defs, inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="720" viewBox="0 0 720 720"><defs>${defs}</defs><rect width="720" height="720" fill="#FFFFFF"/>${inner}</svg>`
}

function heroClaude() {
  const L = '#7A3E22'
  const defs = '<linearGradient id="hg" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="#F2692C"/><stop offset=".55" stop-color="#FB8B5C"/><stop offset="1" stop-color="#FFAFC2"/></linearGradient>'
  const deco = `
${star4(632, 142, 17, '#FFD23F', 12)}${star4(558, 92, 11, '#FFD23F', -8)}${star4(86, 318, 12, '#FFD23F', 20)}
${star4(648, 438, 11, '#FF8A5C', -14)}${star4(76, 566, 13, '#FFD23F', 6)}${star4(586, 628, 10, '#FFB199', 24)}
${featherD(600, 268, 0.85, 28, '#F2784B', L)}${featherD(92, 246, 0.7, -24, '#FF9E80', L)}${featherD(624, 522, 0.7, 58, '#F2784B', L)}`
  // 迷你分身：站在一根大羽毛上挥手
  const mini = `
${featherD(126, 168, 1.7, 42, '#FFB199', L)}
<path d="M138 178 Q150 172 162 178 L164 204 Q150 210 136 204 Z" fill="#6B4226" stroke="#5A3420" stroke-width="3"/>
<circle cx="150" cy="150" r="23" fill="${SKIN}" stroke="#E0A98F" stroke-width="3"/>
<path d="M127 148 Q124 118 150 112 Q176 118 173 148 Q162 130 150 130 Q138 130 127 148 Z" fill="#F2784B" stroke="#7A3E22" stroke-width="3"/>
<path d="M129 132 Q118 118 120 100 Q134 110 138 126 Z" fill="#8D5A3B" stroke="#5A3420" stroke-width="2.5"/>
<path d="M171 132 Q182 118 180 100 Q166 110 162 126 Z" fill="#8D5A3B" stroke="#5A3420" stroke-width="2.5"/>
<path d="M144 114 Q140 92 150 86 Q154 98 153 114 Z" fill="#F2784B" stroke="#7A3E22" stroke-width="2.5"/>
<path d="M156 114 Q160 92 150 86 Q146 98 147 114 Z" fill="#FF9E80" stroke="#7A3E22" stroke-width="2.5"/>
<circle cx="142" cy="150" r="3.4" fill="#E8912D"/><circle cx="158" cy="150" r="3.4" fill="#E8912D"/>
<ellipse cx="150" cy="162" rx="5" ry="3.6" fill="#A84A52"/>
<path d="M162 180 Q176 162 176 140" stroke="${SKIN}" stroke-width="7" fill="none" stroke-linecap="round"/>
<circle cx="177" cy="136" r="6.5" fill="${SKIN}" stroke="#E0A98F" stroke-width="2.5"/>
${star4(208, 96, 10, '#FFD23F', 18)}`
  const main = `
<!-- 摊开的硬皮笔记本（封皮 + 内页 + 手写笔记 + 羽毛笔） -->
<path d="M220 542 L600 522 L612 600 L236 616 Z" fill="#8D5A3B" stroke="#5A3420" stroke-width="5" stroke-linejoin="round"/>
<path d="M232 544 L586 528 L596 592 L248 606 Z" fill="#F7EEDD" stroke="#B98A5E" stroke-width="4" stroke-linejoin="round"/>
<path d="M410 530 L416 596" stroke="#C9B89A" stroke-width="4" stroke-linecap="round"/>
<path d="M262 558 L330 554 M262 574 L344 570 M264 590 L326 586 M440 552 L528 548 M440 568 L540 564 M442 584 L512 580" stroke="#B99B7E" stroke-width="3.4" stroke-linecap="round" opacity=".85"/>
<path d="M352 556 L372 552 L380 564 L360 570 Z M486 556 q10 -10 20 0 q-10 8 -20 0 Z" fill="none" stroke="#C77B46" stroke-width="2.6" stroke-linecap="round" opacity=".8"/>
${featherD(572, 470, 0.95, 34, '#F2784B', L)}
<!-- 猫头鹰尾羽：四片圆头长羽扇形摊开在笔记本上 -->
<path d="M366 528 Q300 552 262 612 Q262 634 290 632 Q330 606 366 556 Z" fill="#FF9E80" stroke="#7A3E22" stroke-width="4.5" stroke-linejoin="round"/>
<path d="M360 516 Q268 522 206 580 Q196 606 224 612 Q292 596 356 544 Z" fill="#F2784B" stroke="#7A3E22" stroke-width="4.5" stroke-linejoin="round"/>
<path d="M356 504 Q256 492 182 540 Q172 566 200 572 Q272 560 350 524 Z" fill="#E86A3C" stroke="#7A3E22" stroke-width="4.5" stroke-linejoin="round"/>
<path d="M352 494 Q268 470 214 508 Q200 528 220 538 Q288 530 348 510 Z" fill="#F2784B" stroke="#7A3E22" stroke-width="4.5" stroke-linejoin="round"/>
<path d="M214 508 Q198 516 204 530 Q218 528 222 516 Z M182 540 Q170 550 178 562 Q192 558 194 548 Z M206 580 Q198 596 214 604 Q224 592 222 582 Z M262 612 Q264 626 282 626 Q286 612 276 604 Z" fill="#FFC4A8"/>
<path d="M348 510 Q286 506 226 522 M348 524 Q270 528 202 552 M352 540 Q286 552 226 592 M360 556 Q316 576 282 616" stroke="#C95E2E" stroke-width="3" fill="none" stroke-linecap="round"/>
<!-- 背后的小猫头鹰翅膀 -->
<path d="M318 452 Q262 446 246 490 Q284 496 320 480 Z" fill="#8D5A3B" stroke="#5A3420" stroke-width="4" stroke-linejoin="round"/>
<path d="M262 480 Q278 470 296 472 M268 490 Q286 482 306 482" stroke="#B9825F" stroke-width="2.8" fill="none" stroke-linecap="round"/>
<path d="M482 452 Q538 446 554 490 Q516 496 480 480 Z" fill="#8D5A3B" stroke="#5A3420" stroke-width="4" stroke-linejoin="round"/>
<path d="M558 480 Q542 470 524 472 M552 490 Q534 482 514 482" stroke="#B9825F" stroke-width="2.8" fill="none" stroke-linecap="round"/>
${backHairArt(L, 'hg', 'long')}
<!-- 头顶两根猫头鹰羽冠 + 棕色翅状耳 -->
<path d="M304 198 Q252 186 244 138 Q274 128 308 154 Q318 176 304 198 Z" fill="#8D5A3B" stroke="#5A3420" stroke-width="4.5" stroke-linejoin="round"/>
<path d="M496 198 Q548 186 556 138 Q526 128 492 154 Q482 176 496 198 Z" fill="#8D5A3B" stroke="#5A3420" stroke-width="4.5" stroke-linejoin="round"/>
<path d="M262 146 Q282 152 300 166 M258 164 Q278 170 296 182" stroke="#B9825F" stroke-width="3" fill="none" stroke-linecap="round"/>
<path d="M538 146 Q518 152 500 166 M542 164 Q522 170 504 182" stroke="#B9825F" stroke-width="3" fill="none" stroke-linecap="round"/>
<path d="M384 116 Q366 52 392 28 Q404 70 404 116 Z" fill="#F2784B" stroke="#7A3E22" stroke-width="4" stroke-linejoin="round"/>
<path d="M416 116 Q434 52 408 28 Q396 70 396 116 Z" fill="#FF9E80" stroke="#7A3E22" stroke-width="4" stroke-linejoin="round"/>
<!-- 深棕吊带连体衣 -->
<path d="M304 426 Q400 398 496 426 L510 512 Q400 544 290 512 Z" fill="#6B4226" stroke="#5A3420" stroke-width="5" stroke-linejoin="round"/>
<path d="M356 424 Q360 446 352 462 M444 424 Q440 446 448 462" stroke="#A66B3E" stroke-width="7" fill="none" stroke-linecap="round"/>
<circle cx="${HX}" cy="${HY}" r="112" fill="${SKIN}" stroke="#E0A98F" stroke-width="4"/>
${bangsArt(L, '#FF9E80', true)}
${faceArt(HX, HY, '#E8912D', '#4A2A12', 'owl')}
${armsArt('#6B4226', SKIN, '#C9917A')}`
  return sceneWrap(defs, deco + mini + main)
}

function heroCodex() {
  const L = '#0B3D2E'
  const defs = '<linearGradient id="hg" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="#0FA35C"/><stop offset=".55" stop-color="#1FC16B"/><stop offset="1" stop-color="#9BF3C6"/></linearGradient>'
  const deco = `
${star4(632, 142, 17, '#FFD23F', 12)}${star4(556, 90, 11, '#34E08B', -8)}${star4(84, 318, 12, '#FFD23F', 20)}
${star4(648, 456, 11, '#34E08B', -14)}${star4(74, 566, 12, '#FFD23F', 6)}
<text x="584" y="252" font-family="monospace" font-size="36" font-weight="bold" fill="#0FA866">{ }</text>
<text x="74" y="330" font-family="monospace" font-size="30" font-weight="bold" fill="#0FA866">&lt;/&gt;</text>
<g stroke="#0B3D2E" stroke-width="2.4" stroke-linejoin="round">${gearD(650, 298, 14, '#34E08B')}${gearD(92, 432, 10, '#7BE8B0')}</g>`
  // 迷你分身：坐在终端黑框窗口里探头
  const mini = `
<rect x="60" y="128" width="132" height="92" rx="12" fill="#15131F" stroke="#3A3550" stroke-width="4"/>
<rect x="60" y="128" width="132" height="26" rx="12" fill="#262237"/>
<circle cx="78" cy="141" r="4" fill="#FF5F57"/><circle cx="94" cy="141" r="4" fill="#FEBC2E"/><circle cx="110" cy="141" r="4" fill="#28C840"/>
<text x="80" y="196" font-family="monospace" font-size="20" font-weight="bold" fill="#7BE8B0">&gt; codex_</text>
<ellipse cx="128" cy="118" rx="31" ry="27" fill="#2B333F" stroke="#1B2430" stroke-width="3"/>
<circle cx="128" cy="110" r="24" fill="${SKIN}" stroke="#E0A98F" stroke-width="3"/>
<path d="M104 108 Q102 84 128 78 Q154 84 152 108 Q140 94 128 94 Q116 94 104 108 Z" fill="#12B86B" stroke="#0B3D2E" stroke-width="3"/>
<path d="M106 96 L98 64 L134 90 Z" fill="#1FC16B" stroke="#0B3D2E" stroke-width="3" stroke-linejoin="round"/>
<path d="M112 88 L110 74 L126 88 Z" fill="#FFFFFF"/>
<path d="M150 96 L158 64 L122 90 Z" fill="#1FC16B" stroke="#0B3D2E" stroke-width="3" stroke-linejoin="round"/>
<path d="M144 88 L146 74 L130 88 Z" fill="#FFFFFF"/>
<path d="M126 78 Q130 54 146 56 Q138 70 134 86 Z" fill="#1FC16B" stroke="#0B3D2E" stroke-width="2.6"/>
<circle cx="120" cy="112" r="3.6" fill="#10B981"/><circle cx="136" cy="112" r="3.6" fill="#10B981"/>
<path d="M122 126 Q128 130 134 126" stroke="#A84A52" stroke-width="3" fill="none" stroke-linecap="round"/>
<circle cx="160" cy="146" r="8" fill="${SKIN}" stroke="#E0A98F" stroke-width="2.5"/>
${star4(210, 104, 10, '#FFD23F', 18)}`
  const main = `
<!-- 笔记本电脑：屏幕（绿终端代码+光标）+ 键盘底座 + 齿轮 -->
<g transform="rotate(-4 410 500)">
<rect x="268" y="452" width="286" height="98" rx="12" fill="#10151F" stroke="#6B7280" stroke-width="5"/>
<text x="292" y="486" font-family="monospace" font-size="21" font-weight="bold" fill="#34E08B">&gt; npm run build</text>
<text x="292" y="514" font-family="monospace" font-size="18" fill="#7BE8B0">✓ 21 frames ok</text>
<rect x="446" y="524" width="14" height="20" fill="#34E08B"/>
</g>
<path d="M236 548 L592 540 L606 582 L222 590 Z" fill="#C7CDD6" stroke="#6B7280" stroke-width="5" stroke-linejoin="round"/>
<path d="M300 556 L472 552 L474 572 L298 576 Z" fill="#9AA3B2" opacity=".9"/>
<path d="M496 556 L540 554 L542 572 L498 574 Z" fill="#8A91A0"/>
<g stroke="#4B5563" stroke-width="2.6" stroke-linejoin="round">${gearD(352, 566, 12, '#8A91A0')}${gearD(472, 562, 9, '#6B7280')}</g>
<!-- 绿色猫尾（白尖） -->
<path d="M470 502 Q566 496 598 418 Q608 384 584 368 Q566 394 560 430 Q540 472 476 486 Z" fill="#1FC16B" stroke="#0B3D2E" stroke-width="5" stroke-linejoin="round"/>
<ellipse cx="586" cy="366" rx="15" ry="22" transform="rotate(20 586 366)" fill="#FFFFFF" stroke="#0B3D2E" stroke-width="4"/>
<!-- 连帽卫衣帽子（猫耳从帽子开孔伸出） -->
<ellipse cx="${HX}" cy="252" rx="140" ry="128" fill="#2B333F" stroke="#1B2430" stroke-width="5"/>
${backHairArt(L, 'hg', 'short')}
<!-- 白色猫耳（绿耳尖）+ 呆毛 -->
<path d="M300 180 L280 84 L364 150 Z" fill="#FFFFFF" stroke="#0B3D2E" stroke-width="4.5" stroke-linejoin="round"/>
<path d="M496 180 L516 84 L432 150 Z" fill="#FFFFFF" stroke="#0B3D2E" stroke-width="4.5" stroke-linejoin="round"/>
<path d="M280 84 L289 127 L318 114 Z" fill="#1FC16B" stroke="#0B3D2E" stroke-width="3" stroke-linejoin="round"/>
<path d="M516 84 L507 127 L478 114 Z" fill="#1FC16B" stroke="#0B3D2E" stroke-width="3" stroke-linejoin="round"/>
<path d="M308 164 L305 130 L346 148 Z" fill="#BFF5D9"/>
<path d="M488 164 L491 130 L450 148 Z" fill="#BFF5D9"/>
<path d="M398 106 Q404 48 438 42 Q414 80 414 114 Z" fill="#1FC16B" stroke="#0B3D2E" stroke-width="4" stroke-linejoin="round"/>
<!-- 深灰连帽卫衣 -->
<path d="M304 426 Q400 400 496 426 L510 510 Q400 540 290 510 Z" fill="#374151" stroke="#1B2430" stroke-width="5" stroke-linejoin="round"/>
<path d="M372 432 Q400 458 428 432" stroke="#4B5563" stroke-width="7" fill="none" stroke-linecap="round"/>
<path d="M392 448 L386 474 M408 448 L414 474" stroke="#9AA3B2" stroke-width="4" fill="none" stroke-linecap="round"/>
<circle cx="${HX}" cy="${HY}" r="112" fill="${SKIN}" stroke="#E0A98F" stroke-width="4"/>
${bangsArt(L, '#7BE8B0', false)}
${faceArt(HX, HY, '#10B981', '#0B3D2E', 'cat')}
${armsArt('#374151', SKIN, '#C9917A')}`
  return sceneWrap(defs, deco + mini + main)
}

function heroOpenCode() {
  const L = '#262057'
  const defs = '<linearGradient id="hg" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="#3C2AAE"/><stop offset=".55" stop-color="#6B54E8"/><stop offset="1" stop-color="#BCAFFF"/></linearGradient>'
  const deco = `
${star4(632, 142, 17, '#FFD23F', 12)}${star4(558, 90, 11, '#9B8CFF', -8)}${star4(84, 318, 12, '#FFD23F', 20)}
${star4(650, 456, 11, '#9B8CFF', -14)}${star4(74, 566, 12, '#FFD23F', 6)}
<text x="600" y="262" font-family="monospace" font-size="34" font-weight="bold" fill="#7C5CFC">~/</text>
<text x="76" y="366" font-family="monospace" font-size="30" font-weight="bold" fill="#7C5CFC">&gt;_</text>
<text x="606" y="396" font-family="monospace" font-size="34" font-weight="bold" fill="#9B8CFF">|</text>`
  // 迷你分身：从终端弹窗探头，举 >_ 小牌
  const mini = `
<rect x="62" y="138" width="126" height="86" rx="12" fill="#15131F" stroke="#3A3550" stroke-width="4"/>
<rect x="62" y="138" width="126" height="24" rx="12" fill="#262237"/>
<rect x="82" y="141" width="40" height="13" rx="4" fill="#3B3656"/>
<rect x="128" y="141" width="40" height="13" rx="4" fill="#3B3656"/>
<circle cx="76" cy="150" r="3.4" fill="#FF5F57"/><circle cx="90" cy="150" r="3.4" fill="#FEBC2E"/><circle cx="104" cy="150" r="3.4" fill="#28C840"/>
<ellipse cx="126" cy="146" rx="32" ry="27" fill="#22222E" stroke="#17161F" stroke-width="3"/>
<circle cx="126" cy="140" r="25" fill="${SKIN}" stroke="#E0A98F" stroke-width="3"/>
<path d="M101 138 Q99 112 126 106 Q153 112 151 138 Q138 122 126 122 Q114 122 101 138 Z" fill="#7C5CFC" stroke="#262057" stroke-width="3"/>
<path d="M104 124 L92 86 L142 110 Z" fill="#7C5CFC" stroke="#262057" stroke-width="3" stroke-linejoin="round"/>
<path d="M148 124 L160 86 L110 110 Z" fill="#7C5CFC" stroke="#262057" stroke-width="3" stroke-linejoin="round"/>
<path d="M108 116 L102 98 L134 112 Z" fill="#D9D2FF"/>
<path d="M144 116 L150 98 L118 112 Z" fill="#D9D2FF"/>
<path d="M124 106 Q116 84 132 78 Q146 82 140 98 Q134 106 128 106 Z" fill="#9B8CFF" stroke="#262057" stroke-width="2.6"/>
<circle cx="118" cy="142" r="3.6" fill="#7C5CFC"/><circle cx="134" cy="142" r="3.6" fill="#7C5CFC"/>
<path d="M120 156 Q126 160 132 156" stroke="#A84A52" stroke-width="3" fill="none" stroke-linecap="round"/>
<rect x="146" y="166" width="40" height="26" rx="6" fill="#FFFFFF" stroke="#7C5CFC" stroke-width="3"/>
<text x="154" y="185" font-family="monospace" font-size="17" font-weight="bold" fill="#7C5CFC">&gt;_</text>
<circle cx="148" cy="168" r="7" fill="${SKIN}" stroke="#E0A98F" stroke-width="2.5"/>
${star4(210, 110, 10, '#FFD23F', 18)}`
  const main = `
<!-- 蓬松紫色狐尾（白尾尖），蜷在终端左侧 -->
<path d="M336 492 Q206 472 162 560 Q132 626 208 632 Q286 626 336 562 Q362 522 366 500 Z" fill="#7C5CFC" stroke="#262057" stroke-width="5" stroke-linejoin="round"/>
<path d="M166 556 Q134 596 150 628 Q190 636 214 610 Q184 600 176 576 Q172 564 180 548 Q170 548 166 556 Z" fill="#FFFFFF" stroke="#262057" stroke-width="4" stroke-linejoin="round"/>
<!-- 多标签页黑色终端窗口 -->
<rect x="240" y="506" width="332" height="98" rx="13" fill="#15131F" stroke="#3A3550" stroke-width="5"/>
<rect x="240" y="506" width="332" height="28" rx="13" fill="#262237"/>
<rect x="258" y="512" width="62" height="16" rx="5" fill="#3B3656"/>
<rect x="326" y="512" width="62" height="16" rx="5" fill="#3B3656"/>
<circle cx="252" cy="520" r="4" fill="#FF5F57"/><circle cx="266" cy="520" r="4" fill="#FEBC2E"/><circle cx="280" cy="520" r="4" fill="#28C840"/>
<text x="266" y="568" font-family="monospace" font-size="23" font-weight="bold" fill="#B7A8FF">&gt; opencode run</text>
<rect x="436" y="555" width="15" height="21" fill="#B7A8FF"/>
<text x="266" y="592" font-family="monospace" font-size="17" fill="#7BE8B0">3 models · ok</text>
${backHairArt(L, 'hg', 'long')}
<!-- 紫色狐狸耳（浅紫内耳）+ 卷曲呆毛 -->
<path d="M298 182 L266 84 L370 146 Z" fill="#7C5CFC" stroke="#262057" stroke-width="4.5" stroke-linejoin="round"/>
<path d="M502 182 L534 84 L430 146 Z" fill="#7C5CFC" stroke="#262057" stroke-width="4.5" stroke-linejoin="round"/>
<path d="M308 166 L292 112 L350 144 Z" fill="#D9D2FF"/>
<path d="M492 166 L508 112 L450 144 Z" fill="#D9D2FF"/>
<path d="M392 108 Q372 44 412 34 Q452 28 440 72 Q432 100 406 104 Q404 98 408 94 Q426 86 422 66 Q418 52 402 58 Q390 72 396 108 Z" fill="#9B8CFF" stroke="#262057" stroke-width="4" stroke-linejoin="round"/>
<!-- 黑色短款连帽衫 -->
<path d="M304 426 Q400 398 496 426 L508 508 Q400 538 292 508 Z" fill="#23222E" stroke="#17161F" stroke-width="5" stroke-linejoin="round"/>
<path d="M368 430 Q400 452 432 430" stroke="#3A3550" stroke-width="6" fill="none" stroke-linecap="round"/>
<!-- 六边形开源徽章吊饰 -->
<polygon points="400,454 420,465 420,487 400,498 380,487 380,465" fill="#7C5CFC" stroke="#B7A8FF" stroke-width="3.4" stroke-linejoin="round"/>
<polygon points="400,465 411,471 411,483 400,489 389,483 389,471" fill="#FFFFFF" opacity=".92"/>
<circle cx="${HX}" cy="${HY}" r="112" fill="${SKIN}" stroke="#E0A98F" stroke-width="4"/>
${bangsArt(L, '#B3A6FF', true)}
${faceArt(HX, HY, '#7C5CFC', '#2A2270', 'fox')}
${armsArt('#23222E', SKIN, '#C9917A')}`
  return sceneWrap(defs, deco + mini + main)
}

function heroDeepSeek() {
  const L = '#12306B'
  const defs = '<linearGradient id="hg" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="#174A8E"/><stop offset=".55" stop-color="#2F7FD6"/><stop offset="1" stop-color="#93D2FF"/></linearGradient>'
  const deco = `
${star4(632, 142, 17, '#FFD23F', 12)}${star4(558, 90, 11, '#FFD23F', -8)}${star4(84, 318, 12, '#FFD23F', 20)}
${star4(648, 456, 11, '#7FC8F8', -14)}${star4(74, 566, 12, '#FFD23F', 6)}${star4(600, 250, 11, '#FFD23F', 24)}`
  // 迷你分身：趴在小鲸鱼尾上挥手
  const mini = `
<path d="M112 214 Q70 196 52 226 Q82 236 112 224 Z" fill="#7FC8F8" stroke="#12306B" stroke-width="3.4" stroke-linejoin="round"/>
<path d="M108 232 Q66 240 62 270 Q92 264 116 240 Z" fill="#7FC8F8" stroke="#12306B" stroke-width="3.4" stroke-linejoin="round"/>
<path d="M118 210 Q150 196 178 176" stroke="#1E5AA8" stroke-width="20" fill="none" stroke-linecap="round"/>
<path d="M128 176 Q142 168 158 174 L162 200 Q146 208 130 200 Z" fill="#1E4E8C" stroke="#12306B" stroke-width="3"/>
<circle cx="146" cy="150" r="24" fill="${SKIN}" stroke="#E0A98F" stroke-width="3"/>
<path d="M122 148 Q119 118 146 112 Q173 118 170 148 Q158 130 146 130 Q134 130 122 148 Z" fill="#1E5AA8" stroke="#12306B" stroke-width="3"/>
<path d="M124 132 Q104 122 100 102 Q122 110 134 126 Z" fill="#2F7FD6" stroke="#12306B" stroke-width="2.8"/>
<path d="M168 132 Q188 122 192 102 Q170 110 158 126 Z" fill="#2F7FD6" stroke="#12306B" stroke-width="2.8"/>
<path d="M144 112 Q136 86 156 80 Q172 86 164 106 Q158 116 150 114 Z" fill="#7FC8F8" stroke="#12306B" stroke-width="2.6"/>
<circle cx="138" cy="152" r="3.6" fill="#3B82F6"/><circle cx="154" cy="152" r="3.6" fill="#3B82F6"/>
<path d="M140 164 Q146 169 152 164" stroke="#A84A52" stroke-width="3" fill="none" stroke-linecap="round"/>
<path d="M158 178 Q176 160 178 136" stroke="${SKIN}" stroke-width="7" fill="none" stroke-linecap="round"/>
<circle cx="179" cy="132" r="6.5" fill="${SKIN}" stroke="#E0A98F" stroke-width="2.5"/>
${star4(208, 96, 10, '#FFD23F', 18)}`
  const main = `
<!-- 蓝色纹理厚书 -->
<path d="M236 520 L580 508 L596 600 L250 614 Z" fill="#2F7FD6" stroke="#12306B" stroke-width="5" stroke-linejoin="round"/>
<path d="M250 590 L596 578 L596 600 L250 614 Z" fill="#BFE3FF" stroke="#12306B" stroke-width="4" stroke-linejoin="round"/>
<path d="M270 544 Q330 536 400 540 T556 532 M272 566 Q340 558 420 562 T560 554" stroke="#1E5AA8" stroke-width="3.4" fill="none" stroke-linecap="round" opacity=".75"/>
<path d="M262 522 L262 600" stroke="#1E5AA8" stroke-width="4" opacity=".8"/>
<!-- 完整深蓝鲸鱼尾（浅蓝尾鳍），蜷在左侧 -->
<path d="M342 498 Q232 474 168 548 Q118 612 182 642 Q244 662 304 602 Q346 562 366 522 Z" fill="#1E4E8C" stroke="#12306B" stroke-width="5" stroke-linejoin="round"/>
<path d="M176 596 Q236 626 296 592 Q260 622 206 622 Q182 614 176 596 Z" fill="#8FC7FF" opacity=".9"/>
<path d="M172 548 Q112 504 94 544 Q128 566 164 576 Z" fill="#7FC8F8" stroke="#12306B" stroke-width="4.5" stroke-linejoin="round"/>
<path d="M162 582 Q108 602 116 642 Q158 630 186 598 Z" fill="#7FC8F8" stroke="#12306B" stroke-width="4.5" stroke-linejoin="round"/>
${backHairArt(L, 'hg', 'long')}
<!-- 腰间金色环扣（扣在鲸尾根部，画在头发之后保证可见） -->
<ellipse cx="312" cy="552" rx="22" ry="12" transform="rotate(-36 312 552)" fill="none" stroke="#F5C542" stroke-width="8.5"/>
<circle cx="326" cy="540" r="4.5" fill="#FFE08A" stroke="#B8860B" stroke-width="2"/>
<!-- 鲸鱼鳍状小耳 + 卷曲呆毛 -->
<path d="M296 196 Q236 180 228 124 Q272 138 306 170 Z" fill="#2F7FD6" stroke="#12306B" stroke-width="4.5" stroke-linejoin="round"/>
<path d="M504 196 Q564 180 572 124 Q528 138 494 170 Z" fill="#2F7FD6" stroke="#12306B" stroke-width="4.5" stroke-linejoin="round"/>
<path d="M248 138 Q268 148 290 160 M552 138 Q532 148 510 160" stroke="#8FC7FF" stroke-width="3" fill="none" stroke-linecap="round"/>
<path d="M392 108 Q372 44 412 34 Q452 28 440 72 Q432 100 406 104 Q404 98 408 94 Q426 86 422 66 Q418 52 402 58 Q390 72 396 108 Z" fill="#7FC8F8" stroke="#12306B" stroke-width="4" stroke-linejoin="round"/>
<!-- 深蓝吊带连体衣（下身收进鲸尾） -->
<path d="M304 426 Q400 398 496 426 L506 508 Q400 536 294 508 Z" fill="#1E4E8C" stroke="#12306B" stroke-width="5" stroke-linejoin="round"/>
<path d="M356 424 Q360 446 352 462 M444 424 Q440 446 448 462" stroke="#4A9BE0" stroke-width="7" fill="none" stroke-linecap="round"/>
<circle cx="${HX}" cy="${HY}" r="112" fill="${SKIN}" stroke="#E0A98F" stroke-width="4"/>
${bangsArt(L, '#8FC7FF', true)}
${faceArt(HX, HY, '#3B82F6', '#14306B', 'whale')}
${armsArt('#1E4E8C', SKIN, '#C9917A')}`
  return sceneWrap(defs, deco + mini + main)
}

function heroZcode() {
  const L = '#123A8A'
  const defs = '<linearGradient id="hg" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="#1E4FC4"/><stop offset=".55" stop-color="#3E7BE8"/><stop offset="1" stop-color="#A8C8FF"/></linearGradient>'
  const deco = `
${star4(632, 142, 17, '#FFD23F', 12)}${star4(558, 92, 11, '#5C9BFF', -8)}${star4(84, 318, 12, '#FFD23F', 20)}
${star4(648, 456, 11, '#5C9BFF', -14)}${star4(74, 566, 12, '#FFD23F', 6)}
<text x="588" y="256" font-family="monospace" font-size="34" font-weight="bold" fill="#2E6BE6">{;}</text>
<text x="74" y="336" font-family="monospace" font-size="30" font-weight="bold" fill="#2E6BE6">&gt;_</text>
<text x="612" y="398" font-family="monospace" font-size="32" font-weight="bold" fill="#7FB0FF">~</text>`
  // 迷你分身：坐在终端窗口里探头
  const mini = `
<rect x="60" y="130" width="132" height="90" rx="12" fill="#111A2E" stroke="#2E6BE6" stroke-width="4"/>
<rect x="60" y="130" width="132" height="24" rx="12" fill="#1B2946"/>
<circle cx="78" cy="142" r="4" fill="#FF5F57"/><circle cx="94" cy="142" r="4" fill="#FEBC2E"/><circle cx="110" cy="142" r="4" fill="#28C840"/>
<text x="80" y="198" font-family="monospace" font-size="19" font-weight="bold" fill="#8FC0FF">glm&gt;_</text>
<circle cx="128" cy="112" r="25" fill="${SKIN}" stroke="#E0A98F" stroke-width="3"/>
<path d="M103 110 Q100 82 128 76 Q156 82 153 110 Q140 94 128 94 Q116 94 103 110 Z" fill="#2E6BE6" stroke="#123A8A" stroke-width="3"/>
<path d="M126 78 Q120 56 136 52 Q148 58 142 74 Q136 84 130 82 Z" fill="#8FC0FF" stroke="#123A8A" stroke-width="2.6"/>
<rect x="112" y="100" width="14" height="11" rx="3" fill="none" stroke="#123A8A" stroke-width="2.6"/>
<rect x="130" y="100" width="14" height="11" rx="3" fill="none" stroke="#123A8A" stroke-width="2.6"/>
<circle cx="120" cy="114" r="3.4" fill="#2E6BE6"/><circle cx="136" cy="114" r="3.4" fill="#2E6BE6"/>
<path d="M122 128 Q128 132 134 128" stroke="#A84A52" stroke-width="3" fill="none" stroke-linecap="round"/>
<circle cx="160" cy="146" r="8" fill="${SKIN}" stroke="#E0A98F" stroke-width="2.5"/>
${star4(208, 100, 10, '#FFD23F', 18)}`
  const main = `
<!-- 终端窗口（她趴在上面）：黑框 + 蓝色提示符 + 代码行 -->
<rect x="238" y="498" width="336" height="106" rx="13" fill="#111A2E" stroke="#2E6BE6" stroke-width="5"/>
<rect x="238" y="498" width="336" height="28" rx="13" fill="#1B2946"/>
<circle cx="256" cy="512" r="4" fill="#FF5F57"/><circle cx="272" cy="512" r="4" fill="#FEBC2E"/><circle cx="288" cy="512" r="4" fill="#28C840"/>
<text x="314" y="513" font-family="monospace" font-size="14" fill="#7FB0FF">zhipu-glm</text>
<text x="264" y="562" font-family="monospace" font-size="22" font-weight="bold" fill="#9BC4FF">&gt; glm chat</text>
<rect x="440" y="549" width="14" height="20" fill="#9BC4FF"/>
<text x="264" y="588" font-family="monospace" font-size="16" fill="#8FC0FF">200 ok</text>
${backHairArt(L, 'hg', 'long')}
<!-- 呆毛 + 左侧终端窗口发饰 -->
<path d="M398 106 Q404 48 436 40 Q412 78 412 112 Z" fill="#2E6BE6" stroke="#123A8A" stroke-width="4" stroke-linejoin="round"/>
<g transform="rotate(-12 306 176)">
<rect x="266" y="150" width="78" height="52" rx="8" fill="#111A2E" stroke="#2E6BE6" stroke-width="4"/>
<rect x="266" y="150" width="78" height="14" rx="8" fill="#1B2946"/>
<text x="280" y="192" font-family="monospace" font-size="15" font-weight="bold" fill="#8FC0FF">&gt;_</text>
</g>
<!-- 科技蓝上衣 -->
<path d="M304 426 Q400 398 496 426 L508 508 Q400 538 292 508 Z" fill="#2A5FC4" stroke="#123A8A" stroke-width="5" stroke-linejoin="round"/>
<path d="M372 430 Q400 456 428 430" stroke="#5B8FF0" stroke-width="6" fill="none" stroke-linecap="round"/>
<circle cx="${HX}" cy="${HY}" r="112" fill="${SKIN}" stroke="#E0A98F" stroke-width="4"/>
${bangsArt(L, '#A8C8FF', true)}
${faceArt(HX, HY, '#2E6BE6', '#122B66', 'owl')}
${armsArt('#2A5FC4', SKIN, '#C9917A')}`
  return sceneWrap(defs, deco + mini + main)
}

function heroArk() {
  const L = '#0A2E7A'
  const defs = '<linearGradient id="hg" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="#0F47C0"/><stop offset=".55" stop-color="#1664FF"/><stop offset="1" stop-color="#8FB6FF"/></linearGradient>'
  const deco = `
${star4(632, 142, 17, '#FFD23F', 12)}${star4(558, 92, 11, '#FF7A3C', -8)}${star4(84, 318, 12, '#FFD23F', 20)}
${star4(648, 456, 11, '#FF7A3C', -14)}${star4(74, 566, 12, '#FFD23F', 6)}
<path d="M596 282 Q604 268 612 282 Q604 296 596 282 Z" fill="#FF7A3C"/><path d="M104 386 Q112 372 120 386 Q112 400 104 386 Z" fill="#FF9A5C"/>`
  // 迷你分身：坐在熔岩气泡上挥手
  const mini = `
<path d="M132 190 Q108 168 118 140 Q146 138 158 162 Q154 186 132 190 Z" fill="#FF7A3C" stroke="#C24A16" stroke-width="3.4" stroke-linejoin="round"/>
<path d="M126 168 Q136 160 148 166" stroke="#FFD0A8" stroke-width="3" fill="none" stroke-linecap="round"/>
<circle cx="140" cy="120" r="25" fill="${SKIN}" stroke="#E0A98F" stroke-width="3"/>
<path d="M115 118 Q112 90 140 84 Q168 90 165 118 Q152 102 140 102 Q128 102 115 118 Z" fill="#1664FF" stroke="#0A2E7A" stroke-width="3"/>
<path d="M120 96 Q106 84 108 66 Q126 74 132 90 Z" fill="#3E4C6E" stroke="#1B2430" stroke-width="2.6"/>
<path d="M160 96 Q174 84 172 66 Q154 74 148 90 Z" fill="#3E4C6E" stroke="#1B2430" stroke-width="2.6"/>
<path d="M136 88 Q128 62 148 54 Q160 62 152 82 Q146 90 140 88 Z" fill="#0F47C0" stroke="#0A2E7A" stroke-width="2.6"/>
<circle cx="132" cy="122" r="3.6" fill="#1664FF"/><circle cx="148" cy="122" r="3.6" fill="#1664FF"/>
<path d="M134 134 Q140 138 146 134" stroke="#A84A52" stroke-width="3" fill="none" stroke-linecap="round"/>
<path d="M162 148 Q176 130 178 106" stroke="${SKIN}" stroke-width="7" fill="none" stroke-linecap="round"/>
<circle cx="179" cy="102" r="6.5" fill="${SKIN}" stroke="#E0A98F" stroke-width="2.5"/>
${star4(208, 92, 10, '#FFD23F', 18)}`
  const main = `
<!-- 火山岩台座（熔岩裂纹） -->
<path d="M232 546 L592 532 L604 592 L224 610 Z" fill="#2A3350" stroke="#131A2E" stroke-width="5" stroke-linejoin="round"/>
<path d="M256 552 L556 540 L560 552 L252 566 Z" fill="#3C4A73"/>
<path d="M286 556 L372 550 L392 590 L300 598 Z" fill="#FF7A3C" opacity=".92"/>
<path d="M420 548 L500 544 L512 586 L430 594 Z" fill="#FFB03C" opacity=".85"/>
<path d="M300 560 L360 556 M310 576 L368 572 M436 556 L494 552 M444 572 L500 568" stroke="#FFD0A8" stroke-width="3" fill="none" stroke-linecap="round" opacity=".8"/>
${backHairArt(L, 'hg', 'long')}
<!-- 一对小犄角 + 发顶小火山（冒熔岩） -->
<path d="M302 206 Q286 166 300 144 Q318 162 320 200 Z" fill="#3E4C6E" stroke="#1B2430" stroke-width="4.5" stroke-linejoin="round"/>
<path d="M498 206 Q514 166 500 144 Q482 162 480 200 Z" fill="#3E4C6E" stroke="#1B2430" stroke-width="4.5" stroke-linejoin="round"/>
<path d="M374 116 L400 68 L426 116 Z" fill="#3E4C6E" stroke="#1B2430" stroke-width="4.5" stroke-linejoin="round"/>
<path d="M378 116 L400 78 L422 116 Z" fill="#2A3350"/>
<path d="M386 92 Q400 74 414 92 Q406 86 400 92 Q394 86 386 92 Z" fill="#FF7A3C"/>
<ellipse cx="400" cy="66" rx="16" ry="8" fill="#FFB03C" stroke="#C24A16" stroke-width="3"/>
<!-- 深蓝熔岩纹上衣 -->
<path d="M304 426 Q400 398 496 426 L508 508 Q400 538 292 508 Z" fill="#1B3E8F" stroke="#0A2E7A" stroke-width="5" stroke-linejoin="round"/>
<path d="M340 470 L376 452 L412 476 L448 456" stroke="#FF7A3C" stroke-width="4" fill="none" stroke-linecap="round" opacity=".9"/>
<circle cx="${HX}" cy="${HY}" r="112" fill="${SKIN}" stroke="#E0A98F" stroke-width="4"/>
${bangsArt(L, '#8FB6FF', true)}
${faceArt(HX, HY, '#1664FF', '#0A2350', 'owl')}
${armsArt('#1B3E8F', SKIN, '#C9917A')}`
  return sceneWrap(defs, deco + mini + main)
}

function heroDsh() {
  const L = '#0B5C6B'
  const defs = '<linearGradient id="hg" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="#0E7C90"/><stop offset=".55" stop-color="#22D3EE"/><stop offset="1" stop-color="#A5EFFA"/></linearGradient>'
  const hex = (cx, cy, r, fill, stroke) => `<polygon points="${cx},${cy - r} ${cx + r * 0.87},${cy - r / 2} ${cx + r * 0.87},${cy + r / 2} ${cx},${cy + r} ${cx - r * 0.87},${cy + r / 2} ${cx - r * 0.87},${cy - r / 2}" fill="${fill}"${stroke !== undefined ? ` stroke="${stroke}" stroke-width="3"` : ''}/>`
  const deco = `
${star4(632, 142, 17, '#FFD23F', 12)}${star4(558, 92, 11, '#22D3EE', -8)}${star4(84, 318, 12, '#FFD23F', 20)}
${star4(648, 456, 11, '#22D3EE', -14)}${star4(74, 566, 12, '#FFD23F', 6)}
${hex(604, 286, 13, 'none', '#22D3EE')}${hex(96, 400, 10, 'none', '#5FE3F5')}`
  // 迷你分身：趴在小鲸鱼上挥手
  const mini = `
<path d="M112 214 Q70 196 52 226 Q82 236 112 224 Z" fill="#A5EFFA" stroke="#0B5C6B" stroke-width="3.4" stroke-linejoin="round"/>
<path d="M108 232 Q66 240 62 270 Q92 264 116 240 Z" fill="#A5EFFA" stroke="#0B5C6B" stroke-width="3.4" stroke-linejoin="round"/>
<path d="M118 210 Q150 196 178 176" stroke="#22D3EE" stroke-width="20" fill="none" stroke-linecap="round"/>
<circle cx="146" cy="150" r="24" fill="${SKIN}" stroke="#E0A98F" stroke-width="3"/>
<path d="M122 148 Q119 118 146 112 Q173 118 170 148 Q158 130 146 130 Q134 130 122 148 Z" fill="#22D3EE" stroke="#0B5C6B" stroke-width="3"/>
<path d="M124 132 Q104 122 100 102 Q122 110 134 126 Z" fill="#22D3EE" stroke="#0B5C6B" stroke-width="2.8"/>
<path d="M168 132 Q188 122 192 102 Q170 110 158 126 Z" fill="#22D3EE" stroke="#0B5C6B" stroke-width="2.8"/>
<path d="M144 112 Q136 86 156 80 Q172 86 164 106 Q158 116 150 114 Z" fill="#A5EFFA" stroke="#0B5C6B" stroke-width="2.6"/>
<circle cx="138" cy="152" r="3.6" fill="#0E7C90"/><circle cx="154" cy="152" r="3.6" fill="#0E7C90"/>
<path d="M140 164 Q146 169 152 164" stroke="#A84A52" stroke-width="3" fill="none" stroke-linecap="round"/>
<path d="M158 178 Q176 160 178 136" stroke="${SKIN}" stroke-width="7" fill="none" stroke-linecap="round"/>
<circle cx="179" cy="132" r="6.5" fill="${SKIN}" stroke="#E0A98F" stroke-width="2.5"/>
${star4(208, 96, 10, '#FFD23F', 18)}`
  const main = `
<!-- 六边形数据面板 -->
<path d="M240 532 L580 522 L596 594 L252 606 Z" fill="#0D3B47" stroke="#062A33" stroke-width="5" stroke-linejoin="round"/>
${hex(320, 564, 22, '#12626F', '#22D3EE')}${hex(392, 560, 22, '#12626F', '#5FE3F5')}${hex(464, 556, 22, '#12626F', '#22D3EE')}
${hex(536, 552, 16, '#0D3B47', '#5FE3F5')}
${backHairArt(L, 'hg', 'long')}
<!-- 发顶六边形光环 + 鲸鱼鳍状小耳 -->
<g transform="rotate(-18 400 86)">${hex(400, 74, 26, 'none', '#22D3EE')}${hex(400, 74, 15, 'none', '#A5EFFA')}</g>
<path d="M296 196 Q236 180 228 124 Q272 138 306 170 Z" fill="#22D3EE" stroke="#0B5C6B" stroke-width="4.5" stroke-linejoin="round"/>
<path d="M504 196 Q564 180 572 124 Q528 138 494 170 Z" fill="#22D3EE" stroke="#0B5C6B" stroke-width="4.5" stroke-linejoin="round"/>
<path d="M248 138 Q268 148 290 160 M552 138 Q532 148 510 160" stroke="#A5EFFA" stroke-width="3" fill="none" stroke-linecap="round"/>
<!-- 深青吊带连体衣 -->
<path d="M304 426 Q400 398 496 426 L506 508 Q400 536 294 508 Z" fill="#12626F" stroke="#0B5C6B" stroke-width="5" stroke-linejoin="round"/>
<path d="M356 424 Q360 446 352 462 M444 424 Q440 446 448 462" stroke="#5FE3F5" stroke-width="7" fill="none" stroke-linecap="round"/>
<circle cx="${HX}" cy="${HY}" r="112" fill="${SKIN}" stroke="#E0A98F" stroke-width="4"/>
${bangsArt(L, '#A5EFFA', true)}
${faceArt(HX, HY, '#22D3EE', '#083F4A', 'whale')}
${armsArt('#12626F', SKIN, '#C9917A')}`
  return sceneWrap(defs, deco + mini + main)
}

function heroGemini() {
  const L = '#3A2E8F'
  const defs = '<linearGradient id="hg" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="#4A3BC0"/><stop offset=".55" stop-color="#7B6CF6"/><stop offset="1" stop-color="#C4BAFF"/></linearGradient>'
  /** 四色四芒星（Gemini 四色） */
  const gemstar = (cx, cy, s = 1) => `<g transform="translate(${cx} ${cy}) scale(${s})">
<path d="M0 0 L4.6 -4.6 L0 -22 L-4.6 -4.6 Z" fill="#4285F4"/>
<path d="M0 0 L4.6 4.6 L22 0 L4.6 -4.6 Z" fill="#EA4335"/>
<path d="M0 0 L4.6 4.6 L0 22 L-4.6 4.6 Z" fill="#FBBC05"/>
<path d="M0 0 L-4.6 4.6 L-22 0 L-4.6 -4.6 Z" fill="#34A853"/></g>`
  const deco = `
${star4(632, 142, 17, '#FFD23F', 12)}${star4(84, 318, 12, '#FFD23F', 20)}${star4(74, 566, 12, '#FFD23F', 6)}
${gemstar(596, 268, 0.72)}${gemstar(112, 386, 0.55)}${gemstar(628, 500, 0.5)}`
  // 迷你分身：站在四色星上挥手
  const mini = `
${gemstar(140, 206, 1.5)}
<circle cx="140" cy="118" r="25" fill="${SKIN}" stroke="#E0A98F" stroke-width="3"/>
<path d="M115 116 Q112 88 140 82 Q168 88 165 116 Q152 100 140 100 Q128 100 115 116 Z" fill="#7B6CF6" stroke="#3A2E8F" stroke-width="3"/>
<path d="M136 86 Q128 60 148 52 Q160 60 152 80 Q146 88 140 86 Z" fill="#BCB2FF" stroke="#3A2E8F" stroke-width="2.6"/>
${gemstar(140, 66, 0.42)}
<circle cx="132" cy="120" r="3.6" fill="#7B6CF6"/><circle cx="148" cy="120" r="3.6" fill="#7B6CF6"/>
<path d="M134 132 Q140 136 146 132" stroke="#A84A52" stroke-width="3" fill="none" stroke-linecap="round"/>
<path d="M162 146 Q176 128 178 104" stroke="${SKIN}" stroke-width="7" fill="none" stroke-linecap="round"/>
<circle cx="179" cy="100" r="6.5" fill="${SKIN}" stroke="#E0A98F" stroke-width="2.5"/>
${star4(210, 168, 10, '#FFD23F', 18)}`
  const main = `
<!-- 摊开的星空书 -->
<path d="M220 542 L600 522 L612 600 L236 616 Z" fill="#2B2566" stroke="#1A1546" stroke-width="5" stroke-linejoin="round"/>
<path d="M232 544 L586 528 L596 592 L248 606 Z" fill="#3A3380" stroke="#1A1546" stroke-width="4" stroke-linejoin="round"/>
<path d="M410 530 L416 596" stroke="#5B52B0" stroke-width="4" stroke-linecap="round"/>
${star4(300, 560, 9, '#FFD23F', 10)}${star4(346, 580, 7, '#BCB2FF', -12)}${star4(486, 552, 8, '#A5EFFA', 20)}${star4(534, 578, 7, '#FFD23F', -6)}
${star4(276, 588, 6, '#BCB2FF', 16)}${star4(508, 592, 6, '#A5EFFA', 4)}
${backHairArt(L, 'hg', 'long')}
<!-- 波浪发丝 + 发顶四色四芒星 -->
<path d="M300 300 Q282 356 300 412 M500 300 Q518 356 500 412" stroke="#C4BAFF" stroke-width="3.4" fill="none" stroke-linecap="round" opacity=".85"/>
<path d="M398 104 Q406 46 436 40 Q410 78 412 112 Z" fill="#7B6CF6" stroke="#3A2E8F" stroke-width="4" stroke-linejoin="round"/>
${gemstar(402, 62, 1.05)}
<!-- 白色星空上衣 -->
<path d="M304 426 Q400 398 496 426 L506 508 Q400 536 294 508 Z" fill="#EDEBFF" stroke="#3A2E8F" stroke-width="5" stroke-linejoin="round"/>
${star4(352, 470, 8, '#7B6CF6', 12)}${star4(448, 462, 7, '#4285F4', -14)}${star4(400, 496, 6, '#EA4335', 20)}
<circle cx="${HX}" cy="${HY}" r="112" fill="${SKIN}" stroke="#E0A98F" stroke-width="4"/>
${bangsArt(L, '#C4BAFF', true)}
${faceArt(HX, HY, '#7B6CF6', '#332878', 'owl')}
${armsArt('#D9D4FF', SKIN, '#C9917A')}`
  return sceneWrap(defs, deco + mini + main)
}

const HERO_ART = {
  'claude-girl': heroClaude,
  'codex-girl': heroCodex,
  'opencode-girl': heroOpenCode,
  'deepseek-girl': heroDeepSeek,
  'zcode-girl': heroZcode,
  'ark-girl': heroArk,
  'dsh-girl': heroDsh,
  'gemini-girl': heroGemini,
}

// ─── Chrome CDP（与 pet-assets-generate.mjs 同款无头渲染） ───────────────────

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
]
function chromeBin() {
  const flag = process.argv.indexOf('--chrome')
  if (flag >= 0 && process.argv[flag + 1] !== undefined) return process.argv[flag + 1]
  for (const c of CHROME_CANDIDATES) if (c !== undefined && existsSync(c)) return c
  throw new Error('未找到 Chrome/Edge：用 --chrome <path> 指定')
}

let cdpClient = null
async function getCdp() {
  if (cdpClient !== null) return cdpClient
  const port = 9338
  const profile = join(tmpdir(), 'dsh-pod-sticker-profile')
  const proc = spawn(chromeBin(), [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' })
  let wsUrl
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (r.ok) {
        const list = await r.json()
        const page = list.find((t) => t.type === 'page')
        if (page !== undefined) { wsUrl = page.webSocketDebuggerUrl; break }
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  if (wsUrl === undefined) { proc.kill(); throw new Error('Chrome CDP 未就绪') }
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let msgId = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data))
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  const cdp = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++msgId
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  cdpClient = { ws, proc, cdp }
  return cdpClient
}

// ─── 浏览器侧管线：去白底 → 贴纸描边 → 六轨帧 ─────────────────────────────────

const PIPELINE_FN = `(async (job) => {
  const img = new Image();
  img.src = job.dataUrl;
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('hero load fail')); });
  const W = img.naturalWidth, H = img.naturalHeight;
  const src = document.createElement('canvas'); src.width = W; src.height = H;
  const sctx = src.getContext('2d'); sctx.drawImage(img, 0, 0);
  const imgData = sctx.getImageData(0, 0, W, H);
  const d = imgData.data;
  const whiteish = (r, g, b) => { const mn = Math.min(r, g, b), mx = Math.max(r, g, b); return mn > 232 && (mx - mn) < 26; };

  // 1) 边缘洪泛去白底（只删与画布连通的白；本子内页/眼白等被深色线条围住的白保留）
  const vis = new Uint8Array(W * H);
  const stack = [];
  const push = (x, y) => { const i = y * W + x; if (!vis[i] && whiteish(d[i * 4], d[i * 4 + 1], d[i * 4 + 2])) { vis[i] = 1; stack.push(i); } };
  for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
  for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
  while (stack.length) {
    const i = stack.pop();
    d[i * 4 + 3] = 0;
    const y = (i / W) | 0, x = i - y * W;
    if (x > 0) push(x - 1, y);
    if (x < W - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < H - 1) push(x, y + 1);
  }
  // 2) 去白边毛边（贴透明边的近白像素两轮 = 吃掉旧描边/抗锯齿白晕，后面重建统一新描边）
  for (let p = 0; p < 2; p++) {
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      if (d[o + 3] === 0) continue;
      const r = d[o], g = d[o + 1], b = d[o + 2], mn = Math.min(r, g, b), mx = Math.max(r, g, b);
      if (mn > 225 && (mx - mn) < 36) {
        const y = (i / W) | 0, x = i - y * W;
        let near = false;
        for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          if (d[(ny * W + nx) * 4 + 3] === 0) { near = true; break; }
        }
        if (near) d[o + 3] = 0;
      }
    }
  }
  sctx.putImageData(imgData, 0, 0);

  // 3) 裁切不透明内容包围盒
  let minX = W, minY = H, maxX = 0, maxY = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (d[(y * W + x) * 4 + 3] > 16) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX <= minX || maxY <= minY) throw new Error('去白底后内容为空（主视觉可能不是白底？）');
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  const trim = document.createElement('canvas'); trim.width = bw; trim.height = bh;
  const tctx = trim.getContext('2d');
  tctx.drawImage(src, minX, minY, bw, bh, 0, 0, bw, bh);

  // 4) alpha 膨胀 → 统一白色贴纸粗描边
  const td = tctx.getImageData(0, 0, bw, bh), tdd = td.data;
  const mask = new Uint8Array(bw * bh);
  for (let i = 0; i < bw * bh; i++) mask[i] = tdd[i * 4 + 3] > 20 ? 1 : 0;
  const R = Math.max(6, Math.round(bw * 0.016));
  const tmp = new Uint8Array(bw * bh), dil = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    const row = y * bw; let cnt = 0;
    for (let x = 0; x < bw; x++) { if (mask[row + x]) cnt = R + 1; else if (cnt > 0) cnt--; if (cnt > 0) tmp[row + x] = 1; }
    cnt = 0;
    for (let x = bw - 1; x >= 0; x--) { if (mask[row + x]) cnt = R + 1; else if (cnt > 0) cnt--; if (cnt > 0) tmp[row + x] = 1; }
  }
  for (let x = 0; x < bw; x++) {
    let cnt = 0;
    for (let y = 0; y < bh; y++) { if (tmp[y * bw + x]) cnt = R + 1; else if (cnt > 0) cnt--; if (cnt > 0) dil[y * bw + x] = 1; }
    cnt = 0;
    for (let y = bh - 1; y >= 0; y--) { if (tmp[y * bw + x]) cnt = R + 1; else if (cnt > 0) cnt--; if (cnt > 0) dil[y * bw + x] = 1; }
  }
  const border = document.createElement('canvas'); border.width = bw; border.height = bh;
  const bctx = border.getContext('2d');
  const bd = bctx.createImageData(bw, bh);
  for (let i = 0; i < bw * bh; i++) if (dil[i]) {
    const o = i * 4; bd.data[o] = 255; bd.data[o + 1] = 255; bd.data[o + 2] = 255; bd.data[o + 3] = 255;
  }
  bctx.putImageData(bd, 0, 0);
  bctx.drawImage(trim, 0, 0);
  const pad = R + 4;
  const master = document.createElement('canvas'); master.width = bw + pad * 2; master.height = bh + pad * 2;
  master.getContext('2d').drawImage(border, pad, pad);

  // 5) 贴纸风小配件（白色粗描边 = 先画白色大一号底，再画彩色）
  function sparkle(ctx, x, y, r, color, a) {
    ctx.save(); ctx.globalAlpha = a; ctx.translate(x, y);
    const p = (rr) => {
      ctx.beginPath(); ctx.moveTo(0, -rr);
      ctx.quadraticCurveTo(rr * 0.22, -rr * 0.22, rr, 0);
      ctx.quadraticCurveTo(rr * 0.22, rr * 0.22, 0, rr);
      ctx.quadraticCurveTo(-rr * 0.22, rr * 0.22, -rr, 0);
      ctx.quadraticCurveTo(-rr * 0.22, -rr * 0.22, 0, -rr); ctx.closePath();
    };
    p(r * 1.45); ctx.fillStyle = '#fff'; ctx.fill();
    p(r); ctx.fillStyle = color; ctx.fill();
    ctx.restore();
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function hudChip(ctx, word, cursor, brand) {
    const x = 124, y = 10, w = 60, h = 36;
    ctx.save();
    roundRect(ctx, x - 2.5, y - 2.5, w + 5, h + 5, 9); ctx.fillStyle = '#fff'; ctx.fill();
    roundRect(ctx, x, y, w, h, 7); ctx.fillStyle = 'rgba(12,16,26,0.94)'; ctx.fill();
    ctx.strokeStyle = brand.primary; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.fillStyle = '#FF5F57'; ctx.beginPath(); ctx.arc(x + 10, y + 9, 2.3, 0, 7); ctx.fill();
    ctx.fillStyle = '#FEBC2E'; ctx.beginPath(); ctx.arc(x + 19, y + 9, 2.3, 0, 7); ctx.fill();
    ctx.fillStyle = '#28C840'; ctx.beginPath(); ctx.arc(x + 28, y + 9, 2.3, 0, 7); ctx.fill();
    ctx.font = '700 11px ui-monospace, monospace'; ctx.textBaseline = 'middle';
    ctx.fillStyle = brand.hud;
    const txt = '> ' + word;
    ctx.fillText(txt, x + 7, y + 25);
    if (cursor) { const m = ctx.measureText(txt); ctx.fillRect(x + 7 + m.width + 3, y + 20, 6, 10); }
    ctx.restore();
  }
  function sweat(ctx, x, y) {
    ctx.save(); ctx.translate(x, y);
    const p = (s) => { ctx.beginPath(); ctx.moveTo(0, -9 * s); ctx.quadraticCurveTo(7 * s, 1 * s, 0, 9 * s); ctx.quadraticCurveTo(-7 * s, 1 * s, 0, -9 * s); ctx.closePath(); };
    p(1.4); ctx.fillStyle = '#fff'; ctx.fill();
    p(1); ctx.fillStyle = '#7FC8F8'; ctx.fill();
    ctx.beginPath(); ctx.ellipse(-2, 2, 1.6, 2.4, -0.4, 0, 7); ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fill();
    ctx.restore();
  }
  function angerMark(ctx, x, y) {
    ctx.save(); ctx.translate(x, y);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 5.5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(0, 1, 7.5, Math.PI * 0.1, Math.PI * 1.35); ctx.stroke();
    const spokes = [[-9, -2, -12, -6], [0, -10, 0, -13.5], [9, -3, 12.5, -7]];
    for (const [x1, y1, x2, y2] of spokes) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
    ctx.strokeStyle = '#FF4D4F'; ctx.lineWidth = 2.8;
    ctx.beginPath(); ctx.arc(0, 1, 7.5, Math.PI * 0.1, Math.PI * 1.35); ctx.stroke();
    for (const [x1, y1, x2, y2] of spokes) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
    ctx.restore();
  }
  function motionLines(ctx, variant, brand) {
    ctx.save(); ctx.globalAlpha = 0.8; ctx.lineCap = 'round';
    const lines = variant === 1
      ? [[38, 66, 28, 56], [34, 108, 24, 98], [154, 74, 164, 64], [158, 116, 168, 106]]
      : [[42, 80, 30, 72], [150, 60, 162, 50], [156, 104, 168, 96], [40, 130, 28, 124]];
    for (const [x1, y1, x2, y2] of lines) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 5.5;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.strokeStyle = brand.soft; ctx.lineWidth = 2.6;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    ctx.restore();
  }

  // 6) 逐帧渲染（192×208，底部中心锚点）
  const FW = 192, FH = 208;
  const scale = Math.min(182 / master.width, 196 / master.height);
  const dw = master.width * scale, dh = master.height * scale;
  const anchorY = FH - 4;
  const out = [];
  for (const f of job.frames) {
    const c = document.createElement('canvas'); c.width = FW; c.height = FH;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.save();
    ctx.translate(96, anchorY);
    ctx.rotate((f.rot ?? 0) * Math.PI / 180);
    ctx.scale(f.sx ?? 1, f.sy ?? 1);
    ctx.translate(0, f.bob ?? 0);
    const fs = f.fs ?? 1; // 逐帧整体缩放（跳起帧略缩 = 透视 + 防顶部裁切）
    ctx.drawImage(master, (-dw * fs) / 2, -dh * fs, dw * fs, dh * fs);
    ctx.restore();
    if (f.hud !== undefined) hudChip(ctx, job.hudWords[f.hud], f.hud % 2 === 1, job.brand);
    if (f.motion !== undefined) motionLines(ctx, f.motion, job.brand);
    for (const s of f.stars ?? []) sparkle(ctx, s.x, s.y, s.r, job.brand.stars[s.c ?? 0], s.a ?? 1);
    if (f.sweat) sweat(ctx, 62, 50);
    if (f.anger) angerMark(ctx, 148, 30);
    const blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.92));
    const dataUrl = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
    out.push({ name: f.name, dataUrl });
  }
  // 主视觉贴纸（460px 宽，透明底）
  const hs = Math.min(1, 460 / master.width);
  const hc = document.createElement('canvas');
  hc.width = Math.round(master.width * hs); hc.height = Math.round(master.height * hs);
  hc.getContext('2d').drawImage(master, 0, 0, hc.width, hc.height);
  const hblob = await new Promise((r) => hc.toBlob(r, 'image/webp', 0.92));
  const heroUrl = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(hblob); });
  out.push({ name: 'hero.webp', dataUrl: heroUrl });
  return out;
})`

function buildFrameJobs(short) {
  const jobs = []
  for (const [track, def] of Object.entries(TRACKS)) {
    def.frames.forEach((pose, i) => {
      jobs.push({ ...pose, track, name: `${short}-pet-${track}${i + 1}.webp` })
    })
  }
  return jobs
}

function buildManifest(id, c) {
  const tracks = {}
  for (const [name, def] of Object.entries(TRACKS)) {
    tracks[name] = {
      frames: def.frames.map((_, i) => `${c.short}-pet-${name}${i + 1}.webp`),
      frameMs: def.frameMs,
      ...(def.loop === false ? { loop: false, fallback: def.fallback } : {}),
    }
  }
  return {
    petManifestVersion: 2,
    id,
    displayName: c.displayName,
    author: 'dsh-pod 桌宠贴纸线',
    license: 'MIT',
    renderer: 'frames2d',
    description: c.description,
    frames2d: {
      dir: '.',
      defaultFrameMs: 200,
      phases: { idle: 'idle', thinking: 'work', tool: 'drag', review: 'work', waiting: 'idle', done: 'success', failed: 'fail' },
      tracks,
    },
    x_dsh_pod: { generatedBy: 'scripts/pet-assets-sticker.mjs', generatedAt: new Date().toISOString(), hero: 'hero.webp', brand: c.brand },
  }
}

/** SVG 主视觉 → 720×720 PNG（Chrome 光栅化），落盘到主视觉目录。 */
async function renderHeroSvg(id) {
  const art = HERO_ART[id]
  if (art === undefined) throw new Error(`未知角色: ${id}（可用: ${CHAR_IDS.join(', ')}）`)
  const svg = art()
  mkdirSync(SRC, { recursive: true })
  const { cdp } = await getCdp()
  const r = await cdp('Runtime.evaluate', {
    expression: `(async () => {
      const svg = ${JSON.stringify(svg)};
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.src = url;
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('svg load fail')); });
      const c = document.createElement('canvas'); c.width = 720; c.height = 720;
      c.getContext('2d').drawImage(img, 0, 0);
      const b = await new Promise((res) => c.toBlob(res, 'image/png'));
      return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); });
    })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r.result?.exceptionDetails !== undefined) {
    throw new Error('SVG 光栅化失败: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400))
  }
  const dataUrl = r.result?.result?.value
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png')) {
    throw new Error('SVG 光栅化返回异常: ' + String(dataUrl).slice(0, 200))
  }
  const dest = join(SRC, `${id}.png`)
  writeFileSync(dest, Buffer.from(dataUrl.split(',')[1], 'base64'))
  return dest
}

async function processCharacter(id) {
  const c = CHARACTERS[id]
  if (c === undefined) throw new Error(`未知角色: ${id}（可用: ${CHAR_IDS.join(', ')}）`)
  const srcPath = join(SRC, `${id}.png`)
  if (!existsSync(srcPath)) {
    process.stdout.write(`[sticker] ${id} 主视觉渲染中（SVG → PNG）…\n`)
    await renderHeroSvg(id)
  }
  const raw = readFileSync(srcPath)
  const mime = raw.subarray(0, 4).toString('ascii') === 'RIFF' && raw.subarray(8, 12).toString('ascii') === 'WEBP'
    ? 'image/webp'
    : raw[0] === 0xff && raw[1] === 0xd8
      ? 'image/jpeg'
      : 'image/png'
  const dataUrl = `data:${mime};base64,` + raw.toString('base64')
  const jobs = buildFrameJobs(c.short)
  const { cdp } = await getCdp()
  const r = await cdp('Runtime.evaluate', {
    expression: `(${PIPELINE_FN})(${JSON.stringify({
      dataUrl,
      frames: jobs,
      hudWords: c.hudWords,
      brand: c.brand,
    })})`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r.result?.exceptionDetails !== undefined) {
    throw new Error('管线失败: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 500))
  }
  const results = r.result?.result?.value ?? []
  if (results.length !== jobs.length + 1) throw new Error(`${id}: 期望 ${jobs.length + 1} 个产物，实际 ${results.length}`)
  const root = join(OUT, id)
  let total = 0
  for (const { name, dataUrl: url } of results) {
    const buf = Buffer.from(url.split(',')[1], 'base64')
    total += buf.length
    if (name === 'hero.webp') {
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, name), buf)
      continue
    }
    const job = jobs.find((j) => j.name === name)
    const dir = join(root, job.track)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), buf)
  }
  writeFileSync(join(root, 'pet.json'), JSON.stringify(buildManifest(id, c), null, 2) + '\n', 'utf8')
  process.stdout.write(`[sticker] ${id} → ${jobs.length} 帧 + hero.webp + pet.json（${Math.round(total / 1024)}KB）\n`)
}

// ─── 主视觉下载（文生图 API 异步出图：首请求返回「生成中」占位图，轮询同一 URL） ─

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 采样判断是否仍是占位图：真贴纸以纯白底为主（白像素占比高），占位图是浅灰底+黑边框。 */
async function imageStats(cdp, dataUrl) {
  const r = await cdp('Runtime.evaluate', {
    expression: `(async (dataUrl) => {
      const img = new Image();
      img.src = dataUrl;
      await new Promise((res) => { img.onload = res; img.onerror = res; });
      const W = img.naturalWidth || 0, H = img.naturalHeight || 0;
      if (W < 50) return { placeholder: true, whiteFraction: 0 };
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, W, H).data;
      let white = 0; const n = W * H;
      for (let i = 0; i < n; i += 377) {
        const o = i * 4, r = d[o], g = d[o + 1], b = d[o + 2];
        const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
        if (mn >= 248 && (mx - mn) < 14) white++;
      }
      return { placeholder: false, whiteFraction: white / Math.ceil(n / 377), W, H };
    })(${JSON.stringify(dataUrl)})`,
    awaitPromise: true,
    returnByValue: true,
  })
  return r.result?.result?.value ?? { placeholder: true, whiteFraction: 0 }
}

async function fetchHero(id) {
  const c = CHARACTERS[id]
  if (c === undefined) throw new Error(`未知角色: ${id}`)
  const url = IMG_API + encodeURIComponent(c.prompt) + '&image_size=square_hd'
  mkdirSync(SRC, { recursive: true })
  const dest = join(SRC, `${id}.png`)
  const { cdp } = await getCdp()
  process.stdout.write(`[fetch] ${id} 主视觉生成中`)
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const ctype = res.headers.get('content-type') ?? ''
    let buf
    let mime = 'image/png'
    if (ctype.includes('application/json')) {
      const j = await res.json()
      const imgUrl = j.url ?? j.data?.url ?? j.image_url ?? j.data?.image_url ?? j.image
      if (typeof imgUrl !== 'string' || !/^https?:\/\//.test(imgUrl)) {
        throw new Error('JSON 响应里找不到图片 URL: ' + JSON.stringify(j).slice(0, 300))
      }
      const r2 = await fetch(imgUrl)
      if (!r2.ok) throw new Error(`图片下载 HTTP ${r2.status}`)
      buf = Buffer.from(await r2.arrayBuffer())
      mime = r2.headers.get('content-type')?.split(';')[0] ?? 'image/png'
    } else {
      buf = Buffer.from(await res.arrayBuffer())
      if (ctype.includes('image/')) mime = ctype.split(';')[0]
    }
    const stats = await imageStats(cdp, `data:${mime};base64,${buf.toString('base64')}`)
    if (!stats.placeholder && stats.whiteFraction > 0.45) {
      writeFileSync(dest, buf)
      process.stdout.write(` 完成（${stats.W}x${stats.H}，白底占比 ${(stats.whiteFraction * 100).toFixed(0)}%）→ ${dest}\n`)
      return
    }
    process.stdout.write('.')
    await sleep(9000)
  }
  throw new Error('主视觉生成超时（多次刷新仍是占位图）')
}

/** 关闭 CDP（无头 Chrome）。 */
function closeCdp() {
  const client = cdpClient
  if (client !== null) {
    try { client.ws.close() } catch { /* ignore */ }
    setTimeout(() => client.proc.kill(), 100)
  }
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const ids = args.length > 0 ? args.filter((a) => CHAR_IDS.includes(a)) : CHAR_IDS
  if (ids.length === 0) throw new Error(`没有匹配的角色（可用: ${CHAR_IDS.join(', ')}）`)
  if (process.argv.includes('--fetch')) {
    for (const id of ids) {
      try {
        await fetchHero(id)
      } catch (e) {
        console.error(`[fetch] ${id} FAILED: ${e.message}`)
        process.exitCode = 1
      }
    }
    return
  }
  // 快速迭代回路：只把主视觉 SVG 光栅化成 PNG（不做去底/描边/六轨），供设计迭代看图
  if (process.argv.includes('--preview')) {
    for (const id of ids) {
      try {
        console.log(`[preview] ${await renderHeroSvg(id)}`)
      } catch (e) {
        console.error(`[preview] ${id} FAILED: ${e.message}`)
        process.exitCode = 1
      }
    }
    closeCdp()
    return
  }
  for (const id of ids) {
    try {
      await processCharacter(id)
    } catch (e) {
      console.error(`[sticker] ${id} FAILED: ${e.message}`)
      process.exitCode = 1
    }
  }
  closeCdp()
}

import { pathToFileURL } from 'node:url'
const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntry) await main()
