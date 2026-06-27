# Templates

Templates are rendered by the MCP server after a job spec passes schema validation and safety checks.

Initial templates:

- `pbs/cpu.pbs.hbs`
- `pbs/gpu.pbs.hbs`
- `pbs/array.pbs.hbs`
- `ihpc/background-run.sh.hbs`
- `transfer/rsync-stage.sh.hbs`

Do not manually submit rendered templates without reviewing the selected profile, queue or node family, resources, walltime, and output paths.

The iHPC background template is a dry-run preview of the supervised start inputs. Live iHPC starts are performed by the MCP `jobs.submit` supervisor path, not by manually running the rendered template.
