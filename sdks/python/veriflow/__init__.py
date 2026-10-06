"""veriflow — official Python client for the Veriflow cloud API.

Zero dependencies (stdlib urllib only), works on Python 3.9+. Point it at your
API with ``Veriflow(api_url=..., token=...)`` or ``Veriflow.from_env()``.

    from veriflow import Veriflow

    vf = Veriflow.from_env()  # VERIFLOW_API_URL / VERIFLOW_API_KEY or VERIFLOW_TOKEN
    run = vf.create_run(objective="open example.com and assert the heading",
                        env_url="https://example.com")
    trace = vf.trace(run["id"])
    print(trace["run"]["status"], len(trace["steps"]), "steps")
"""

from .client import Run, Trace, Veriflow, VeriflowError

__all__ = ["Veriflow", "VeriflowError", "Run", "Trace"]
__version__ = "0.1.0"
