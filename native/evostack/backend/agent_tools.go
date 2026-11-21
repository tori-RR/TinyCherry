package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const maxAgentFileBytes = 1024 * 1024
const maxAgentToolOutput = 32768

func nativeAgentToolSchema(name string) (object, bool) {
	stringField := object{"type": "string"}
	properties := object{}
	required := []any{}
	switch name {
	case "list_files":
		properties["path"] = stringField
	case "read_file":
		properties = object{"path": stringField, "start_line": object{"type": "integer", "minimum": float64(1)}, "line_count": object{"type": "integer", "minimum": float64(1), "maximum": float64(500)}}
		required = []any{"path"}
	case "search_files":
		properties = object{"path": stringField, "query": object{"type": "string", "minLength": float64(1)}}
		required = []any{"query"}
	case "write_file":
		properties = object{"path": stringField, "content": stringField}
		required = []any{"path", "content"}
	case "edit_file":
		properties = object{"path": stringField, "old_text": object{"type": "string", "minLength": float64(1)}, "new_text": stringField}
		required = []any{"path", "old_text", "new_text"}
	case "run_shell":
		properties = object{"command": object{"type": "string", "minLength": float64(1)}, "cwd": stringField, "timeout_seconds": object{"type": "integer", "minimum": float64(1), "maximum": float64(120)}}
		required = []any{"command"}
	default:
		return nil, false
	}
	return object{"type": "object", "properties": properties, "required": required, "additionalProperties": false}, true
}

func nativeAgentToolWrites(name string) bool {
	return name == "write_file" || name == "edit_file" || name == "run_shell"
}

func nativeAgentTools(agent object) []object {
	descriptions := map[string]string{
		"list_files":   "List a directory inside the selected workspace. Paths are relative; default is the workspace root.",
		"read_file":    "Read a text file inside the workspace, optionally selecting a page of lines. Only regular UTF-8 files are readable.",
		"search_files": "Search for a literal text string in workspace text files. Returns bounded path/line matches; skips dependency and build directories.",
		"write_file":   "Create or replace a workspace text file after the user approves this exact path and content. Parent directories are created as needed.",
		"edit_file":    "Replace exactly one occurrence of old_text with new_text inside a workspace file, after user approval. Read the file first.",
		"run_shell":    "Run a foreground shell command after a fresh user approval. cwd is relative to the workspace. Runs on the host, not in a filesystem sandbox; no background jobs. Output and execution time are bounded.",
	}
	result := []object{}
	for _, name := range []string{"list_files", "read_file", "search_files", "write_file", "edit_file", "run_shell"} {
		if contains(array(agent["disabledTools"]), name) || (agentPermissionMode(agent) == "plan" && nativeAgentToolWrites(name)) {
			continue
		}
		schema, _ := nativeAgentToolSchema(name)
		result = append(result, object{"type": "function", "function": object{"name": name, "description": descriptions[name], "parameters": schema}})
	}
	return result
}

func validateNativeAgentArguments(name string, input object) error {
	schema, ok := nativeAgentToolSchema(name)
	if !ok {
		return errors.New("unknown native agent tool")
	}
	if err := validateComputerValue(input, schema); err != nil {
		return fmt.Errorf("native tool arguments: %w", err)
	}
	for _, value := range input {
		if v, ok := value.(string); ok && (strings.ContainsRune(v, '\x00') || len(v) > 49152) {
			return errors.New("native tool text is too long or contains NUL")
		}
	}
	return nil
}

func (s *server) agentToolAllowed(g *generation, name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.agentToolAllowedLocked(g, name)
}

func (s *server) agentToolAllowedLocked(g *generation, name string) error {
	if g.agent == nil || s.active[g.topicID] != g {
		return errors.New("agent turn is no longer active")
	}
	agent, err := s.store.get("agents", g.agent.agentID)
	if err != nil {
		return err
	}
	session, err := s.store.get("agent-sessions", g.agent.sessionID)
	if err != nil {
		return err
	}
	if agent["deletedAt"] != nil || session["deletedAt"] != nil || session["agentId"] != g.agent.agentID || session["workspaceId"] != g.agent.workspaceID {
		return errors.New("agent or workspace ownership changed")
	}
	if contains(array(agent["disabledTools"]), name) {
		return errors.New("the user disabled this tool")
	}
	if nativeAgentToolWrites(name) && (g.agent.mode != "default" || agentPermissionMode(agent) != "default") {
		return errors.New("plan mode is read only; writes and shell commands are unavailable")
	}
	return nil
}

func agentLocalPath(value string) (string, error) {
	if value == "" {
		value = "."
	}
	if !filepath.IsLocal(value) || strings.ContainsRune(value, '\x00') {
		return "", errors.New("tool paths must stay inside the workspace")
	}
	return filepath.Clean(value), nil
}

func readAgentFile(root *os.Root, path string) ([]byte, fs.FileMode, error) {
	info, err := root.Lstat(path)
	if err != nil {
		return nil, 0, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxAgentFileBytes {
		return nil, 0, errors.New("only regular text files up to 1 MiB are supported")
	}
	file, err := openNativeAgentRead(root, path)
	if err != nil {
		return nil, 0, err
	}
	defer file.Close()
	info, err = file.Stat()
	if err != nil {
		return nil, 0, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxAgentFileBytes {
		return nil, 0, errors.New("only regular text files up to 1 MiB are supported")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxAgentFileBytes+1))
	if err != nil {
		return nil, 0, err
	}
	if len(data) > maxAgentFileBytes || !utf8.Valid(data) || strings.ContainsRune(string(data), '\x00') {
		return nil, 0, errors.New("file is too large or is not UTF-8 text")
	}
	return data, info.Mode().Perm(), nil
}

type agentFileEdit struct {
	path    string
	before  [32]byte
	exists  bool
	content []byte
	mode    fs.FileMode
}

func prepareAgentEdit(root *os.Root, name string, input object) (*agentFileEdit, error) {
	path, err := agentLocalPath(text(input["path"]))
	if err != nil || path == "." {
		return nil, errors.New("a file path inside the workspace is required")
	}
	edit := &agentFileEdit{path: path, mode: 0600}
	data, mode, err := readAgentFile(root, path)
	if err == nil {
		edit.exists, edit.before, edit.mode = true, sha256.Sum256(data), mode
	} else if !errors.Is(err, fs.ErrNotExist) || name == "edit_file" {
		return nil, err
	}
	if info, err := root.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return nil, errors.New("editing symlinks or special files is not allowed")
	}
	if name == "write_file" {
		edit.content = []byte(text(input["content"]))
	} else {
		old := text(input["old_text"])
		if old == "" || strings.Count(string(data), old) != 1 {
			return nil, errors.New("old_text must match exactly once; read the file and provide unique context")
		}
		edit.content = []byte(strings.Replace(string(data), old, text(input["new_text"]), 1))
	}
	if len(edit.content) > maxAgentFileBytes {
		return nil, errors.New("edited file exceeds 1 MiB")
	}
	return edit, nil
}

func applyAgentEdit(root *os.Root, edit *agentFileEdit) error {
	// Approval is for the version the user was shown; an intervening change must
	// never be overwritten silently. Root operations also reject symlink escapes.
	current, _, err := readAgentFile(root, edit.path)
	if edit.exists {
		if err != nil || sha256.Sum256(current) != edit.before {
			return errors.New("file changed while approval was pending; read it again before proposing a new edit")
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return errors.New("file appeared while approval was pending; read it before replacing it")
	}
	if err := root.MkdirAll(filepath.Dir(edit.path), 0700); err != nil {
		return err
	}
	temporary := filepath.Join(filepath.Dir(edit.path), ".tinycherry-edit-"+newID())
	file, err := root.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, edit.mode)
	if err != nil {
		return err
	}
	defer root.Remove(temporary)
	_, writeErr := file.Write(edit.content)
	if writeErr == nil {
		writeErr = file.Sync()
	}
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	return root.Rename(temporary, edit.path)
}

func (s *server) executeAgentTool(ctx context.Context, g *generation, name string, input, part object) (object, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := s.agentToolAllowed(g, name); err != nil {
		return nil, err
	}
	root := g.agent.root
	if name == "write_file" || name == "edit_file" {
		edit, err := prepareAgentEdit(root, name, input)
		if err != nil {
			return nil, err
		}
		if err := s.awaitAgentApproval(ctx, g, name, input, part); err != nil {
			return nil, err
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if err := s.agentToolAllowed(g, name); err != nil {
			return nil, err
		}
		if err := applyAgentEdit(root, edit); err != nil {
			return nil, err
		}
		return object{"path": filepath.ToSlash(edit.path), "bytesWritten": len(edit.content), "created": !edit.exists}, nil
	}
	if name == "run_shell" {
		cwd, err := agentLocalPath(text(input["cwd"]))
		if err != nil {
			return nil, err
		}
		dir, err := root.OpenRoot(cwd)
		if err != nil {
			return nil, err
		}
		dir.Close()
		if err := s.awaitAgentApproval(ctx, g, name, input, part); err != nil {
			return nil, err
		}
		if err := s.agentToolAllowed(g, name); err != nil {
			return nil, err
		}
		return runAgentShell(ctx, g.agent.workspacePath, cwd, input)
	}
	path, err := agentLocalPath(text(input["path"]))
	if err != nil {
		return nil, err
	}
	switch name {
	case "list_files":
		directory, err := root.OpenRoot(path)
		if err != nil {
			return nil, err
		}
		defer directory.Close()
		file, err := directory.Open(".")
		if err != nil {
			return nil, err
		}
		defer file.Close()
		entries, err := file.ReadDir(101)
		if err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
		items := []object{}
		for _, entry := range entries[:min(100, len(entries))] {
			kind := "file"
			if entry.IsDir() {
				kind = "directory"
			} else if entry.Type()&fs.ModeSymlink != 0 {
				kind = "symlink"
			}
			items = append(items, object{"name": entry.Name(), "type": kind})
		}
		return object{"path": filepath.ToSlash(path), "entries": items, "truncated": len(entries) > 100}, nil
	case "read_file":
		data, _, err := readAgentFile(root, path)
		if err != nil {
			return nil, err
		}
		lines := strings.Split(string(data), "\n")
		start := min(number(input["start_line"], 1)-1, len(lines))
		end := min(start+min(number(input["line_count"], 200), 500), len(lines))
		content := strings.Join(lines[start:end], "\n")
		truncated := len(content) > maxAgentToolOutput
		return object{"path": filepath.ToSlash(path), "content": boundedAgentText(content, maxAgentToolOutput), "startLine": start + 1, "endLine": end, "totalLines": len(lines), "truncated": truncated || end < len(lines)}, nil
	case "search_files":
		return searchAgentFiles(ctx, root, path, text(input["query"]))
	default:
		return nil, errors.New("unknown native agent tool")
	}
}

func searchAgentFiles(ctx context.Context, root *os.Root, path, query string) (object, error) {
	searchCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	matches, files, outputBytes := []object{}, 0, 0
	truncated := false
	err := fs.WalkDir(root.FS(), filepath.ToSlash(path), func(name string, entry fs.DirEntry, walkErr error) error {
		if err := searchCtx.Err(); err != nil {
			return err
		}
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if name != filepath.ToSlash(path) && (entry.Name() == ".git" || entry.Name() == "node_modules" || entry.Name() == "target" || entry.Name() == ".cache" || strings.Count(name, "/") > 10) {
				return fs.SkipDir
			}
			return nil
		}
		if entry.Type()&fs.ModeSymlink != 0 {
			return nil
		}
		files++
		if files > 1000 {
			truncated = true
			return fs.SkipAll
		}
		data, _, err := readAgentFile(root, filepath.FromSlash(name))
		if err != nil {
			return nil
		}
		for line, content := range strings.Split(string(data), "\n") {
			if strings.Contains(content, query) {
				preview := boundedAgentText(content, 400)
				outputBytes += len(preview) + len(name) + 80
				if len(matches) >= 100 || outputBytes > maxAgentToolOutput {
					truncated = true
					return fs.SkipAll
				}
				matches = append(matches, object{"path": name, "line": line + 1, "text": preview})
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return object{"matches": matches, "filesScanned": files, "truncated": truncated}, nil
}

type agentCommandOutput struct {
	mu        sync.Mutex
	value     []byte
	truncated bool
}

func (b *agentCommandOutput) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(p)
	remaining := maxAgentToolOutput - len(b.value)
	if len(p) > remaining {
		b.truncated = true
		p = p[:remaining]
	}
	b.value = append(b.value, p...)
	return n, nil
}

func agentShellEnvironment() []string {
	// Do not pass the backend's provider keys, tokens or private transport values
	// to subprocesses. Shell still has user privileges, explicitly shown at approval.
	result := []string{}
	for _, key := range []string{"PATH", "HOME", "USER", "USERPROFILE", "SystemRoot", "WINDIR", "PATHEXT", "ComSpec", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"} {
		if value, ok := os.LookupEnv(key); ok {
			result = append(result, key+"="+value)
		}
	}
	return result
}

func runAgentShell(ctx context.Context, workspace, cwd string, input object) (object, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	seconds := min(number(input["timeout_seconds"], 60), 120)
	commandCtx, cancel := context.WithTimeout(ctx, time.Duration(seconds)*time.Second)
	defer cancel()
	command := nativeAgentShell(commandCtx, text(input["command"]))
	command.Dir, command.Env, command.WaitDelay = filepath.Join(workspace, cwd), agentShellEnvironment(), time.Second
	var output agentCommandOutput
	command.Stdout, command.Stderr = &output, &output
	err := command.Run()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	code := 0
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			code = exit.ExitCode()
		} else if commandCtx.Err() == nil {
			return nil, err
		} else {
			code = -1
		}
	}
	return object{"cwd": command.Dir, "exitCode": code, "output": strings.ToValidUTF8(string(output.value), "�"), "truncated": output.truncated, "timedOut": errors.Is(commandCtx.Err(), context.DeadlineExceeded), "doNotAutomaticallyReplay": err != nil}, nil
}
