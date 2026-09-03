using System.Drawing;

namespace HelpdeskAnywhere.Applet.Capture;

/// <summary>
/// The tile geometry behind the dirty-rect optimisation (PLAN 3.3).
///
/// Deliberately free of any dependency on GDI or <c>System.Drawing.Common</c> —
/// only <c>Rectangle</c>, which is cross-platform. That keeps the one piece of
/// Phase 3 arithmetic that is easy to get subtly wrong, and expensive to debug
/// through a screenshot, testable on the Ubuntu dev machine
/// (CLAUDE.md "Hard environment boundary").
/// </summary>
internal static class TileGrid
{
    /// <summary>PLAN 3.3 grid size.</summary>
    public const int TileSize = 128;

    public static int Columns(int width) => (width + TileSize - 1) / TileSize;

    public static int Rows(int height) => (height + TileSize - 1) / TileSize;

    /// <summary>
    /// Merge changed tiles into as few rectangles as possible. One JPEG per changed
    /// tile would spend more on headers and encoder setup than on pixels — a
    /// blinking caret alone dirties a tile every frame.
    ///
    /// Greedy: widen along the row, then deepen only while the whole span below is
    /// also changed. Rectangles never overlap, and the ones on the right and bottom
    /// edges are clipped to the frame so a 1920×1080 desktop does not produce a
    /// rect running to 1920×1152.
    /// </summary>
    public static List<Rectangle> Coalesce(bool[] changed, int cols, int rows, int width, int height)
    {
        var rects = new List<Rectangle>();
        var taken = new bool[changed.Length];

        for (var ty = 0; ty < rows; ty++)
        {
            for (var tx = 0; tx < cols; tx++)
            {
                var index = (ty * cols) + tx;
                if (!changed[index] || taken[index]) continue;

                var spanX = 1;
                while (tx + spanX < cols)
                {
                    var next = index + spanX;
                    if (!changed[next] || taken[next]) break;
                    spanX++;
                }

                var spanY = 1;
                while (ty + spanY < rows)
                {
                    var rowStart = ((ty + spanY) * cols) + tx;
                    var full = true;
                    for (var i = 0; i < spanX; i++)
                    {
                        if (!changed[rowStart + i] || taken[rowStart + i]) { full = false; break; }
                    }
                    if (!full) break;
                    spanY++;
                }

                for (var y = 0; y < spanY; y++)
                {
                    for (var x = 0; x < spanX; x++)
                    {
                        taken[((ty + y) * cols) + tx + x] = true;
                    }
                }

                var px = tx * TileSize;
                var py = ty * TileSize;
                rects.Add(new Rectangle(
                    px,
                    py,
                    Math.Min(spanX * TileSize, width - px),
                    Math.Min(spanY * TileSize, height - py)));
            }
        }

        return rects;
    }
}
