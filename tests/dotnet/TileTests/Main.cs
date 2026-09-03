using System.Drawing;
using HelpdeskAnywhere.Applet.Capture;

int failed = 0;
void Check(string name, bool ok, string detail = "")
{
    if (!ok) failed++;
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")}  {name}{(detail.Length > 0 ? "  — " + detail : "")}");
}

const int T = TileGrid.TileSize;   // 128
const int W = 640, H = 384;        // 5 x 3 tiles exactly
int cols = TileGrid.Columns(W), rows = TileGrid.Rows(H);

bool[] Grid(params (int x, int y)[] tiles)
{
    var g = new bool[cols * rows];
    foreach (var (x, y) in tiles) g[(y * cols) + x] = true;
    return g;
}
static string Show(List<Rectangle> r) => string.Join(" ", r.Select(x => $"({x.X},{x.Y},{x.Width},{x.Height})"));

Console.WriteLine("\n=== TileGrid — dirty-rect coalescing (PLAN 3.3) ===\n");

Check("grid dimensions", cols == 5 && rows == 3, $"{cols}x{rows}");
Check("partial tile rounds up", TileGrid.Columns(1920) == 15 && TileGrid.Rows(1080) == 9,
    $"{TileGrid.Columns(1920)}x{TileGrid.Rows(1080)}");

var none = TileGrid.Coalesce(Grid(), cols, rows, W, H);
Check("nothing changed → no rectangles", none.Count == 0, Show(none));

var one = TileGrid.Coalesce(Grid((1, 1)), cols, rows, W, H);
Check("a single tile → one 128x128 rect at its pixel origin",
    one.Count == 1 && one[0] == new Rectangle(T, T, T, T), Show(one));

var row = TileGrid.Coalesce(Grid((1, 0), (2, 0), (3, 0)), cols, rows, W, H);
Check("three tiles in a row merge into ONE wide rect",
    row.Count == 1 && row[0] == new Rectangle(T, 0, 3 * T, T), Show(row));

var col = TileGrid.Coalesce(Grid((2, 0), (2, 1), (2, 2)), cols, rows, W, H);
Check("three tiles in a column merge into ONE tall rect",
    col.Count == 1 && col[0] == new Rectangle(2 * T, 0, T, 3 * T), Show(col));

var block = TileGrid.Coalesce(Grid((0, 0), (1, 0), (0, 1), (1, 1)), cols, rows, W, H);
Check("a 2x2 block merges into ONE rect",
    block.Count == 1 && block[0] == new Rectangle(0, 0, 2 * T, 2 * T), Show(block));

var split = TileGrid.Coalesce(Grid((0, 0), (4, 2)), cols, rows, W, H);
Check("two far-apart tiles stay two rects", split.Count == 2, Show(split));

// An L shape must not be merged into a rectangle that covers unchanged pixels.
var lshape = TileGrid.Coalesce(Grid((0, 0), (1, 0), (0, 1)), cols, rows, W, H);
var lArea = lshape.Sum(r => r.Width * r.Height);
Check("an L shape never covers unchanged tiles", lArea == 3 * T * T, $"{lArea}px, {Show(lshape)}");

// Every changed tile must be covered exactly once — no gaps, no overlap.
var rnd = new Random(1234);
for (var trial = 0; trial < 200; trial++)
{
    var g = new bool[cols * rows];
    for (var i = 0; i < g.Length; i++) g[i] = rnd.Next(2) == 0;

    var rects = TileGrid.Coalesce(g, cols, rows, W, H);
    var covered = new int[cols * rows];

    foreach (var r in rects)
    {
        for (var y = r.Y / T; y < (r.Y + r.Height + T - 1) / T; y++)
            for (var x = r.X / T; x < (r.X + r.Width + T - 1) / T; x++)
                covered[(y * cols) + x]++;
    }

    for (var i = 0; i < g.Length; i++)
    {
        if (g[i] && covered[i] != 1)
        {
            Check($"random trial {trial}: changed tile {i} covered exactly once", false, $"covered {covered[i]}x");
            trial = 1000; break;
        }
        if (!g[i] && covered[i] != 0)
        {
            Check($"random trial {trial}: unchanged tile {i} never covered", false, $"covered {covered[i]}x");
            trial = 1000; break;
        }
    }
}
Check("200 random grids: every changed tile covered exactly once, no unchanged tile touched", failed == 0);

// Edge clipping: a 1920x1080 desktop is 15x9 tiles but only 1080 tall (8.4 tiles).
int cols2 = TileGrid.Columns(1920), rows2 = TileGrid.Rows(1080);
var edge = new bool[cols2 * rows2];
for (var i = 0; i < edge.Length; i++) edge[i] = true;
var whole = TileGrid.Coalesce(edge, cols2, rows2, 1920, 1080);
Check("a fully-dirty 1920x1080 frame is one rect clipped to the frame",
    whole.Count == 1 && whole[0] == new Rectangle(0, 0, 1920, 1080), Show(whole));

var bottomOnly = new bool[cols2 * rows2];
bottomOnly[((rows2 - 1) * cols2) + cols2 - 1] = true;
var corner = TileGrid.Coalesce(bottomOnly, cols2, rows2, 1920, 1080);
Check("the bottom-right partial tile is clipped, not overhanging",
    corner.Count == 1 && corner[0].Right == 1920 && corner[0].Bottom == 1080, Show(corner));

Console.WriteLine(failed == 0 ? "\n  ALL PASS\n" : $"\n  {failed} FAILED\n");
return failed == 0 ? 0 : 1;
