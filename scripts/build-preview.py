"""Bundle this static app into one reviewable HTML file. No build dependencies."""
import base64
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
output = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "dist" / "sign-studio-preview.html"


def module_body(name):
    source = (root / "js" / name).read_text()
    source = re.sub(r"(?m)^import .*?;\n", "", source)
    return re.sub(r"(?m)^export (?=(const|class|function|async function)\b)", "", source)


font = base64.b64encode((root / "assets/fonts/PretendardVariable.woff2").read_bytes()).decode()
license_text = (root / "assets/fonts/OFL.txt").read_text().replace("*/", "* /")
css = (root / "css/styles.css").read_text().replace(
    "../assets/fonts/PretendardVariable.woff2", "data:font/woff2;base64," + font
)
css = "/* Embedded Pretendard font license:\n" + license_text + "\n*/\n" + css
def module_wrapper(name):
    source = (root / "js" / name).read_text()
    names = re.findall(r"(?m)^export (?:async )?(?:const|class|function) ([A-Za-z_][A-Za-z0-9_]*)", source)
    exports = ", ".join(names)
    return "const { " + exports + " } = (() => {\n" + module_body(name) + "\nreturn { " + exports + " };\n})();\n"


script = "(() => {\n'use strict';\n"
for name in ["storage.js", "engine.js", "video-engine.js", "gemini-video.js", "ai-audit.js", "video-document.js", "personal-library.js", "library-ui.js", "hybrid-ai.js", "video-recorder.js", "recorder-ui.js", "video-chat.js"]:
    script += module_wrapper(name)
script += module_body("app.js") + "\n})();"
script = script.replace("</script", "<\\/script")
html = (root / "index.html").read_text()
html = html.replace('<link rel="stylesheet" href="css/styles.css">', "<style>" + css + "</style>")
html = html.replace('<script type="module" src="js/app.js"></script>', "")
html = html.replace("</body>", "<script>" + script + "</script>\n</body>")
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(html)
print(f"Preview created: {output} ({output.stat().st_size:,} bytes)")
