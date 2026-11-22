"""Build the offline browser version from the same sources as the server."""
import argparse
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def build_standalone():
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    html = html.replace('<html lang="ru">', '<html lang="ru" data-standalone>', 1)
    css = (ROOT / "assets/app.css").read_text(encoding="utf-8")
    parser = (ROOT / "assets/xlsx.full.min.js").read_text(encoding="utf-8")
    license_text = (ROOT / "assets/SHEETJS-LICENSE.txt").read_text(encoding="utf-8")
    modules = re.findall(r'<script defer src="\./(modules/[^"]+)"></script>', html)

    # Keep the vendor parser isolated from the application directives and declarations.
    def script(source):
        escaped_source = re.sub(r"</script", lambda match: r"<\/" + match[0][2:],
                                source, flags=re.IGNORECASE)
        return "<script>\n" + escaped_source + "\n</script>"

    html = html.replace('<link rel="stylesheet" href="./assets/app.css">',
                        "<style>\n" + css + "\n</style>", 1)
    if not modules:
        raise ValueError("В index.html отсутствуют модули DashBar")
    for module in modules:
        tag = f'<script defer src="./{module}"></script>'
        source = (ROOT / module).read_text(encoding="utf-8")
        if module == modules[0]:
            html = html.replace(tag, "<!--\n" + license_text + "\n-->\n" +
                                script(parser) + "\n" + script(source), 1)
        else:
            html = html.replace(tag, script(source), 1)
    return html


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("output", type=Path)
    output = cli.parse_args().output
    output.write_text(build_standalone(), encoding="utf-8")
