"""Marks the test directory as a package.

`test_call_budget.py` imports a helper from `test_preprocess.py` by its
package-qualified name (`from tests.test_preprocess import ...`), which only
resolves when `tests` is a real package. Without this file the import works
under `python -m pytest`, which puts the working directory on `sys.path`, and
fails under a bare `pytest`, which does not. CI runs the latter.

With the file present, pytest walks up past `tests/` when computing the import
base directory and puts `ocr/` on `sys.path` instead, so both `tests` and `app`
resolve however the suite is invoked.
"""
