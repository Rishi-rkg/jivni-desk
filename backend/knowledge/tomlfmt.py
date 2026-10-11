"""Writes the small subset of TOML the library uses. Reading is the standard library's tomllib.

Supported: strings, integers, booleans, lists of strings, tables of those, and lists of tables.
A list of simple entries is written one entry to a line, which is how the remedy files stay readable.
"""

import json
import os
import re
import tempfile
from pathlib import Path

BARE_KEY = re.compile(r"^[A-Za-z0-9_-]+$")


def _key(key):
    return key if BARE_KEY.match(key) else json.dumps(key, ensure_ascii=False)


def _value(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        # A JSON string is a valid TOML basic string, except for the DEL character.
        return json.dumps(value, ensure_ascii=False).replace("\x7f", "\u007f")
    if isinstance(value, list | tuple) and all(isinstance(item, str) for item in value):
        return "[" + ", ".join(_value(item) for item in value) + "]"
    raise TypeError(f"The library file format cannot hold {type(value).__name__} here")


def _is_table_list(value):
    return isinstance(value, list) and bool(value) and all(isinstance(item, dict) for item in value)


def _is_flat(table):
    return not any(isinstance(value, dict) or _is_table_list(value) for value in table.values())


def _inline(table):
    return "{ " + ", ".join(f"{_key(key)} = {_value(value)}" for key, value in table.items()) + " }"


def _table(lines, path, table):
    """Plain values first, then lists of one-line entries, then sub-tables: TOML needs that order."""
    nested = {}
    for key, value in table.items():
        if isinstance(value, dict) or (_is_table_list(value) and not all(_is_flat(item) for item in value)):
            nested[key] = value
        elif not _is_table_list(value):
            lines.append(f"{_key(key)} = {_value(value)}")
    for key, value in table.items():
        if key not in nested and _is_table_list(value):
            lines.extend(["", f"{_key(key)} = ["])
            lines.extend(f"  {_inline(item)}," for item in value)
            lines.append("]")
    for key, value in nested.items():
        name = ".".join([*path, _key(key)])
        if isinstance(value, dict):
            lines.extend(["", f"[{name}]"])
            _table(lines, [*path, _key(key)], value)
        else:
            for item in value:
                lines.extend(["", f"[[{name}]]"])
                _table(lines, [*path, _key(key)], item)


def dumps(data, header=""):
    lines = [f"# {line}".rstrip() for line in header.splitlines()]
    if lines:
        lines.append("")
    _table(lines, [], data)
    return "\n".join(lines).strip("\n") + "\n"


def write(path, data, header=""):
    """Replace the file in one step, so a reader never sees half of it."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=path.parent, prefix=".writing-", suffix=".toml")
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as file:
            file.write(dumps(data, header))
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
