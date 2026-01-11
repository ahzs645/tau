import type { KernelIssue } from '@taucad/types';
import { describe, it, expect } from 'vitest';
import type { GetFileContentsFn } from '#components/geometry/kernel/openscad/parse-output.js';
import { parseStderrLine } from '#components/geometry/kernel/openscad/parse-output.js';

/**
 * Helper to create a GetFileContentsFn from a map of file contents.
 */
function createGetFileContents(files: Record<string, string>): GetFileContentsFn {
  return (fileName: string) => files[fileName];
}

describe('parseStderrLine', () => {
  describe('Parser errors', () => {
    it('should parse error format: ERROR: Parser error in file "X", line Y: message', () => {
      const errors: KernelIssue[] = [];
      parseStderrLine('ERROR: Parser error in file "main.scad", line 118: syntax error', (error) => {
        errors.push(error);
      });

      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual({
        message: 'syntax error',
        location: {
          fileName: 'main.scad',
          startLineNumber: 118,
          startColumn: 1, // 1-based fallback
          endLineNumber: 118,
          endColumn: 1000,
        },
        type: 'compilation',
        severity: 'error',
      });
    });

    it('should parse error format: ERROR: Parser error: message in file X, line Y', () => {
      const errors: KernelIssue[] = [];
      parseStderrLine('ERROR: Parser error: syntax error in file /main.scad, line 118', (error) => {
        errors.push(error);
      });

      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual({
        message: 'syntax error',
        location: {
          fileName: 'main.scad',
          startLineNumber: 118,
          startColumn: 1, // 1-based fallback
          endLineNumber: 118,
          endColumn: 1000,
        },
        type: 'compilation',
        severity: 'error',
      });
    });

    it('should strip leading slashes from filenames', () => {
      const errors: KernelIssue[] = [];
      parseStderrLine('ERROR: Parser error: syntax error in file /path/to/file.scad, line 10', (error) => {
        errors.push(error);
      });

      expect(errors).toHaveLength(1);
      expect(errors[0]?.location?.fileName).toBe('path/to/file.scad');
    });

    it('should parse += syntax errors (compound assignment not supported)', () => {
      // Real error from OpenSCAD when using += operator
      const errors: KernelIssue[] = [];
      parseStderrLine('ERROR: Parser error: syntax error in file /main.scad, line 118', (error) => {
        errors.push(error);
      });

      expect(errors).toHaveLength(1);
      expect(errors[0]?.location?.startLineNumber).toBe(118);
    });

    it('should parse errors with different file paths', () => {
      const errors: KernelIssue[] = [];
      parseStderrLine('ERROR: Parser error: unexpected token in file lib/utils.scad, line 42', (error) => {
        errors.push(error);
      });

      expect(errors).toHaveLength(1);
      expect(errors[0]?.location?.fileName).toBe('lib/utils.scad');
      expect(errors[0]?.location?.startLineNumber).toBe(42);
    });
  });

  describe('Column positions from file contents (1-based)', () => {
    it('should use line content to set start and end columns', () => {
      const errorLine = 'x += 90 + 2*tray_clearance;';
      // eslint-disable-next-line @typescript-eslint/naming-convention -- Test file name
      const getFileContents = createGetFileContents({ 'main.scad': `line 1\n${errorLine}\nline 3` });

      const errors: KernelIssue[] = [];
      parseStderrLine(
        'ERROR: Parser error: syntax error in file /main.scad, line 2',
        (error) => {
          errors.push(error);
        },
        getFileContents,
      );

      expect(errors).toHaveLength(1);
      expect(errors[0]?.location).toEqual({
        fileName: 'main.scad',
        startLineNumber: 2,
        startColumn: 1, // 'x' is at 1-based column 1
        endLineNumber: 2,
        endColumn: errorLine.length + 1, // 1-based exclusive end
      });
    });

    it('should find first non-whitespace character for start column with indented code', () => {
      // Simulate indented error line like "    x += 90 + tray_clearance;"
      const errorLine = '    x += 90 + tray_clearance;';
      // eslint-disable-next-line @typescript-eslint/naming-convention -- Test file name
      const getFileContents = createGetFileContents({ 'main.scad': `line 1\n${errorLine}\nline 3` });

      const errors: KernelIssue[] = [];
      parseStderrLine(
        'ERROR: Parser error: syntax error in file /main.scad, line 2',
        (error) => {
          errors.push(error);
        },
        getFileContents,
      );

      expect(errors).toHaveLength(1);
      expect(errors[0]?.location).toEqual({
        fileName: 'main.scad',
        startLineNumber: 2,
        startColumn: 5, // 'x' is at 1-based column 5 (after 4 spaces)
        endLineNumber: 2,
        endColumn: errorLine.length + 1,
      });
    });

    it('should handle tabs as leading whitespace', () => {
      const errorLine = '\t\tx += 1;';
      // eslint-disable-next-line @typescript-eslint/naming-convention -- Test file name
      const getFileContents = createGetFileContents({ 'main.scad': `line 1\n${errorLine}\nline 3` });

      const errors: KernelIssue[] = [];
      parseStderrLine(
        'ERROR: Parser error: syntax error in file /main.scad, line 2',
        (error) => {
          errors.push(error);
        },
        getFileContents,
      );

      expect(errors).toHaveLength(1);
      expect(errors[0]?.location?.startColumn).toBe(3); // 'x' is at 1-based column 3 (after 2 tabs)
    });

    it('should fallback to 1000 when file is not in contents map', () => {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- Test file name
      const getFileContents = createGetFileContents({ 'other.scad': 'content' });

      const errors: KernelIssue[] = [];
      parseStderrLine(
        'ERROR: Parser error: syntax error in file /main.scad, line 5',
        (error) => {
          errors.push(error);
        },
        getFileContents,
      );

      expect(errors).toHaveLength(1);
      expect(errors[0]?.location?.startColumn).toBe(1); // 1-based fallback
      expect(errors[0]?.location?.endColumn).toBe(1000);
    });

    it('should fallback to 1000 when line number is out of range', () => {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- Test file name
      const getFileContents = createGetFileContents({ 'main.scad': 'line 1\nline 2' });

      const errors: KernelIssue[] = [];
      parseStderrLine(
        'ERROR: Parser error: syntax error in file /main.scad, line 99',
        (error) => {
          errors.push(error);
        },
        getFileContents,
      );

      expect(errors).toHaveLength(1);
      expect(errors[0]?.location?.startColumn).toBe(1); // 1-based fallback
      expect(errors[0]?.location?.endColumn).toBe(1000);
    });
  });

  describe('Warnings', () => {
    it('should parse warning format: WARNING: message in file X, line Y', () => {
      const errors: KernelIssue[] = [];
      parseStderrLine('WARNING: Undefined variable in file model.scad, line 42', (error) => {
        errors.push(error);
      });

      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toBe('Undefined variable');
      expect(errors[0]?.location?.fileName).toBe('model.scad');
      expect(errors[0]?.location?.startLineNumber).toBe(42);
      expect(errors[0]?.location?.endLineNumber).toBe(42);
      expect(errors[0]?.type).toBe('compilation');
    });

    it('should parse warnings with trailing period', () => {
      const errors: KernelIssue[] = [];
      parseStderrLine('WARNING: Variable shadowing, in file test.scad, line 10.', (error) => {
        errors.push(error);
      });

      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toBe('Variable shadowing');
    });

    it('should use actual line content for warnings when file contents provided', () => {
      const errorLine = 'undefined_var = x;';
      // eslint-disable-next-line @typescript-eslint/naming-convention -- Test file name
      const getFileContents = createGetFileContents({ 'model.scad': `line 1\n${errorLine}\nline 3` });

      const errors: KernelIssue[] = [];
      parseStderrLine(
        'WARNING: Undefined variable in file model.scad, line 2',
        (error) => {
          errors.push(error);
        },
        getFileContents,
      );

      expect(errors).toHaveLength(1);
      expect(errors[0]?.location?.startColumn).toBe(1); // 1-based column 1
      expect(errors[0]?.location?.endColumn).toBe(errorLine.length + 1);
    });

    it('should find start column for indented warning lines', () => {
      const errorLine = '  undefined_var = x;';
      // eslint-disable-next-line @typescript-eslint/naming-convention -- Test file name
      const getFileContents = createGetFileContents({ 'model.scad': `line 1\n${errorLine}\nline 3` });

      const errors: KernelIssue[] = [];
      parseStderrLine(
        'WARNING: Undefined variable in file model.scad, line 2',
        (error) => {
          errors.push(error);
        },
        getFileContents,
      );

      expect(errors).toHaveLength(1);
      expect(errors[0]?.location?.startColumn).toBe(3); // 1-based column 3 (after 2 spaces)
      expect(errors[0]?.location?.endColumn).toBe(errorLine.length + 1);
    });
  });

  describe('Severity detection', () => {
    it('should set severity to error for ERROR: Parser error patterns', () => {
      const errors: KernelIssue[] = [];
      parseStderrLine('ERROR: Parser error in file "main.scad", line 5: syntax error', (error) => {
        errors.push(error);
      });

      expect(errors).toHaveLength(1);
      expect(errors[0]?.severity).toBe('error');
    });

    it('should set severity to warning for WARNING: patterns', () => {
      const errors: KernelIssue[] = [];
      parseStderrLine('WARNING: Undefined variable in file main.scad, line 10', (error) => {
        errors.push(error);
      });

      expect(errors).toHaveLength(1);
      expect(errors[0]?.severity).toBe('warning');
    });

    it('should set severity to warning for undefined module warnings', () => {
      const errors: KernelIssue[] = [];
      parseStderrLine("WARNING: Ignoring unknown module 'foo' in file main.scad, line 5", (error) => {
        errors.push(error);
      });

      expect(errors).toHaveLength(1);
      expect(errors[0]?.severity).toBe('warning');
      expect(errors[0]?.message).toContain('Ignoring unknown module');
    });

    it('should set severity to warning for undefined function warnings', () => {
      const errors: KernelIssue[] = [];
      parseStderrLine("WARNING: Ignoring unknown function 'bar' in file main.scad, line 8", (error) => {
        errors.push(error);
      });

      expect(errors).toHaveLength(1);
      expect(errors[0]?.severity).toBe('warning');
    });
  });

  describe('Non-matching messages', () => {
    it('should not call addError for ECHO statements', () => {
      const errors: KernelIssue[] = [];
      parseStderrLine('ECHO: "Hello World"', (error) => {
        errors.push(error);
      });

      expect(errors).toHaveLength(0);
    });

    it('should not call addError for "Can\'t parse file" messages', () => {
      const errors: KernelIssue[] = [];
      parseStderrLine("Can't parse file 'main.scad'!", (error) => {
        errors.push(error);
      });

      expect(errors).toHaveLength(0);
    });

    it('should not call addError for empty strings', () => {
      const errors: KernelIssue[] = [];
      parseStderrLine('', (error) => {
        errors.push(error);
      });

      expect(errors).toHaveLength(0);
    });

    it('should not call addError for generic info messages', () => {
      const errors: KernelIssue[] = [];
      parseStderrLine('Compiling design (CSG Tree generation)...', (error) => {
        errors.push(error);
      });
      parseStderrLine('Rendering Polygon Mesh using CGAL...', (error) => {
        errors.push(error);
      });

      expect(errors).toHaveLength(0);
    });
  });
});
