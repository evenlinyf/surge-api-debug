# Multiple API Debug modules

## Agreed scope

Install the same Module through URLs with different query strings to create multiple instances. Each instance keeps the existing parameter table and handles a different interface. There is no new `name` or reset parameter. Module and script advance together to 1.5.0; published 1.4.2 remains unchanged.

## Approaches

- Separate Module files would require maintaining a finite set of copies; rejected.
- A new user-entered instance name would duplicate information already available in the URL pattern; rejected.
- Use the existing URL pattern and direction for isolation; selected by the user.

## Behavior

- Each exact configured URL pattern plus request/response direction has its own counter. Concrete URLs matched by one regex share a counter.
- Returning to a previously used URL pattern resumes its saved count. Changing a nonzero limit starts a new sequence for that pattern only.
- Manual reset and a qualifying unlimited hit clear only that pattern and direction. Automatic panel refresh never resets a counter.
- Panel content identifies the pattern and direction so similarly titled panels can be distinguished.
- Direct script invocations without a Module URL retain existing script-name-based storage.
- The 1.5.0 storage namespace does not consume, overwrite or reset the old global 1.4.2 Module counter.
- No same-interface multiple-field processing, dynamic Module display names, automatic installation-URL argument mapping, deployment, commit or release is included.

## Validation

Use interleaved requests and manual/automatic panel execution with one shared persistent store. Cover positive, negative and unlimited limits, URL delimiters and direction separation. Run the full existing test suite and the existing 95% V8 coverage gate. Check rendered configuration with the installed Surge CLI.

Surge's offline checker accepts repeated script and panel names. It does not prove how the UI resolves two enabled installed Module instances; distinguish this from VM tests and verify it in the real application when available.
