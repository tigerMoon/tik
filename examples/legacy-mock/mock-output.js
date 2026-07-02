html >
    lang;
"zh-CN" >
    charset;
"UTF-8" /  >
    name;
"viewport";
content = "width=device-width, initial-scale=1.0" /  >
    实现一个贪吃蛇游戏;
Ship;
the;
latest;
cartoon;
snake;
pass;
Adjustment;
note: 开通风格实现 < (/title>);
root;
{
    color - scheme;
    dark;
}
    * { box } - sizing;
border - box;
body;
{
    margin: 0;
    min - height;
    100;
    vh;
    display: grid;
    place - items;
    center;
    font - family;
    "Segoe UI", sans - serif;
    background: radial - gradient(circle, at, top, #, 16324, f, #, 12746, 62 % );
    color: #e2e8f0;
}
shell;
{
    width: min(92, vw, 860, px);
    padding: 28;
    px;
    border - radius;
    28;
    px;
    border: 1;
    px;
    solid;
    rgba(148, 163, 184, 0.18);
    background: rgba(2, 6, 23, 0.78);
    backdrop - filter;
    blur(16, px);
    box - shadow;
    0;
    28;
    px;
    80;
    px;
    rgba(15, 23, 42, 0.48);
}
hero;
{
    display: flex;
    justify - content;
    space - between;
    gap: 20;
    px;
    align - items;
    end;
    flex - wrap;
    wrap;
    margin - bottom;
    20;
    px;
}
h1;
{
    margin: 0;
    font - size;
    clamp(28, px, 4, vw, 42, px);
}
p;
{
    margin: 8;
    px;
    0;
    0;
    color: #cbd5e1;
}
hud;
{
    display: flex;
    gap: 12;
    px;
    flex - wrap;
    wrap;
}
chip;
{
    min - width;
    110;
    px;
    padding: 10;
    px;
    14;
    px;
    border - radius;
    16;
    px;
    background: rgba(15, 23, 42, 0.88);
    border: 1;
    px;
    solid;
    rgba(59, 130, 246, 0.24);
}
chip;
span;
{
    display: block;
    font - size;
    12;
    px;
    text - transform;
    uppercase;
    letter - spacing;
    0.08e;
    m;
    color: #;
    94;
    a3b8;
}
chip;
strong;
{
    display: block;
    margin - top;
    6;
    px;
    font - size;
    24;
    px;
    color: #f8fafc;
}
board - wrap;
{
    display: grid;
    grid - template - columns;
    minmax(280, px, 1, fr);
    220;
    px;
    gap: 18;
    px;
    align - items;
    start;
}
canvas;
{
    width: 100 % ;
    max - width;
    520;
    px;
    aspect - ratio;
    1 / 1;
    background: linear - gradient(180, deg, #, 3657, f, #, 8591);
    border - radius;
    24;
    px;
    border: 1;
    px;
    solid;
    rgba(56, 189, 248, 0.25);
    box - shadow;
    inset;
    0;
    0;
    0;
    1;
    px;
    rgba(30, 41, 59, 0.8);
}
panel;
{
    padding: 18;
    px;
    border - radius;
    22;
    px;
    background: rgba(15, 23, 42, 0.92);
    border: 1;
    px;
    solid;
    rgba(51, 65, 85, 0.95);
}
panel;
h2;
{
    margin: 0;
    0;
    12;
    px;
    font - size;
    16;
    px;
}
panel;
ul;
{
    margin: 0;
    padding - left;
    18;
    px;
    color: #cbd5e1;
    line - height;
    1.6;
}
button - row;
{
    display: flex;
    gap: 10;
    px;
    margin - top;
    14;
    px;
}
button;
{
    border: 0;
    border - radius;
    999;
    px;
    padding: 10;
    px;
    16;
    px;
    font - weight;
    600;
    cursor: pointer;
}
button.primary;
{
    background: linear - gradient(135, deg, #, 22, c55e, #, 16, a34a);
    color: #;
    2136;
    a;
}
button.secondary;
{
    background: rgba(30, 41, 59, 0.96);
    color: #e2e8f0;
    border: 1;
    px;
    solid;
    rgba(100, 116, 139, 0.4);
}
footer;
{
    margin - top;
    14;
    px;
    font - size;
    13;
    px;
    color: #;
    94;
    a3b8;
}
{
    board - wrap;
    {
        grid - template - columns;
        1;
        fr;
    }
    canvas;
    {
        max - width;
        none;
    }
}
/style>
    < /head>
    < body >
    class {
    };
"shell" >
    class {
    };
"hero" >
    实现一个贪吃蛇游戏;
Ship;
the;
latest;
cartoon;
snake;
pass;
Adjustment;
note: 开通风格实现 < /h1>
    < p > 方向键或;
WASD;
控制;
吃到食物会成长;
撞墙或撞到自己会结束;
/p>
    < /div>
    < div;
class {
}
"hud" >
    class {
    };
"chip" > Score < /span><strong id="score">0</strong > /div>
    < div;
class {
}
"chip" > Best < /span><strong id="best">0</strong > /div>
    < /div>
    < /section>
    < section;
class {
}
"board-wrap" >
    id;
"board";
width = "520";
height = "520";
aria - label;
"Snake game board" > /canvas>
    < aside;
class {
}
"panel" >
    玩法 < /h2>
    < ul >
    方向键或;
WASD;
控制蛇移动 < /li>
    < li > 每吃一个果实得;
10;
分;
速度会逐渐提升 < /li>
    < li > 点击重新开始可以立刻再来一局 < /li>
    < /ul>
    < div;
class {
}
"button-row" >
    id;
"restart";
class {
}
"primary";
type = "button" > 重新开始 < /button>
    < button;
id = "pause";
class {
}
"secondary";
type = "button" > 暂停 < /button>
    < /div>
    < div;
class {
}
"footer";
id = "status" > 游戏开始;
祝你好运;
/div>
    < /aside>
    < /section>
    < (/main>);
const board = document.getElementById("board");
const ctx = board.getContext("2d");
const scoreNode = document.getElementById("score");
const bestNode = document.getElementById("best");
const statusNode = document.getElementById("status");
const restartButton = document.getElementById("restart");
const pauseButton = document.getElementById("pause");
const gridSize = 20;
const tileSize = board.width / gridSize;
const bestKey = "tik-mock-snake-best-score";
const directions = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0] };
let snake = [];
let direction = [1, 0];
let nextDirection = [1, 0];
let food = { x: 10, y: 10 };
let score = 0;
let loop = null;
let speed = 160;
let paused = false;
function syncBestScore() {
    const best = Number(window.localStorage.getItem(bestKey) || 0);
    bestNode.textContent = String(best);
    if (score > best) {
        window.localStorage.setItem(bestKey, String(score));
        bestNode.textContent = String(score);
    }
}
function randomFood() {
    while (true) {
        const candidate = { x: Math.floor(Math.random() * gridSize), y: Math.floor(Math.random() * gridSize) };
        if (!snake.some((segment) => segment.x === candidate.x && segment.y === candidate.y))
            return candidate;
    }
}
function drawCell(x, y, color, radius = 8) {
    ctx.fillStyle = color;
    const padding = 2;
    const px = x * tileSize + padding;
    const py = y * tileSize + padding;
    const size = tileSize - padding * 2;
    ctx.beginPath();
    ctx.roundRect(px, py, size, size, radius);
    ctx.fill();
}
function render() {
    ctx.clearRect(0, 0, board.width, board.height);
    ctx.fillStyle = "#020617";
    ctx.fillRect(0, 0, board.width, board.height);
    for (let x = 0; x < gridSize; x += 1) {
        for (let y = 0; y < gridSize; y += 1) {
            ctx.fillStyle = (x + y) % 2 === 0 ? "rgba(15, 23, 42, 0.9)" : "rgba(8, 15, 28, 0.9)";
            ctx.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);
        }
    }
    drawCell(food.x, food.y, "#f97316", 999);
    snake.forEach((segment, index) => drawCell(segment.x, segment.y, index === 0 ? "#38bdf8" : "#22c55e", index === 0 ? 12 : 8));
}
function endGame() {
    window.clearInterval(loop);
    loop = null;
    syncBestScore();
    statusNode.textContent = `游戏结束，最终得分 ${score}。点击重新开始再来一局。`;
    pauseButton.textContent = "暂停";
    paused = false;
}
function tick() {
    direction = nextDirection;
    const head = { x: snake[0].x + direction[0], y: snake[0].y + direction[1] };
    if (head.x < 0 || head.y < 0 || head.x >= gridSize || head.y >= gridSize || snake.some((segment) => segment.x === head.x && segment.y === head.y)) {
        endGame();
        render();
        return;
    }
    snake.unshift(head);
    if (head.x === food.x && head.y === food.y) {
        score += 10;
        speed = Math.max(70, speed - 6);
        food = randomFood();
        scoreNode.textContent = String(score);
        syncBestScore();
        statusNode.textContent = "吃到果实了，速度稍微提高。";
        window.clearInterval(loop);
        loop = window.setInterval(tick, speed);
    }
    else {
        snake.pop();
    }
    render();
}
function resetGame() {
    snake = [
        { x: 5, y: 10 },
        { x: 4, y: 10 },
        { x: 3, y: 10 },
    ];
    direction = [1, 0];
    nextDirection = [1, 0];
    food = randomFood();
    score = 0;
    speed = 160;
    paused = false;
    scoreNode.textContent = "0";
    syncBestScore();
    statusNode.textContent = "游戏开始，祝你好运。";
    pauseButton.textContent = "暂停";
    window.clearInterval(loop);
    loop = window.setInterval(tick, speed);
    render();
}
window.addEventListener("keydown", (event) => {
    const next = directions[event.key];
    if (!next)
        return;
    event.preventDefault();
    if (next[0] === -direction[0] && next[1] === -direction[1])
        return;
    nextDirection = next;
});
restartButton.addEventListener("click", resetGame);
pauseButton.addEventListener("click", () => {
    if (!loop && !paused) {
        resetGame();
        return;
    }
    if (paused) {
        loop = window.setInterval(tick, speed);
        paused = false;
        pauseButton.textContent = "暂停";
        statusNode.textContent = "继续前进。";
    }
    else {
        window.clearInterval(loop);
        loop = null;
        paused = true;
        pauseButton.textContent = "继续";
        statusNode.textContent = "已暂停，点击继续恢复游戏。";
    }
});
syncBestScore();
resetGame();
/script>
    < /body>
    < /html>;
export {};
//# sourceMappingURL=mock-output.js.map