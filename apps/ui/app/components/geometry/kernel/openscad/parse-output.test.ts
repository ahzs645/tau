import type { KernelError } from '@taucad/types';
import { describe, it, expect } from 'vitest';
import { parseStderrLine } from '#components/geometry/kernel/openscad/parse-output.js';

describe('parseStderrLine', () => {
  describe('Parser errors', () => {
    it('should parse error format: ERROR: Parser error in file "X", line Y: message', () => {
      const errors: KernelError[] = [];
      parseStderrLine('ERROR: Parser error in file "main.scad", line 118: syntax error', (error) => {
        errors.push(error);
      });

      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual({
        message: 'syntax error',
        location: { fileName: 'main.scad', startLineNumber: 118, startColumn: 0 },
        type: 'compilation',
      });
    });

    it('should parse error format: ERROR: Parser error: message in file X, line Y', () => {
      const errors: KernelError[] = [];
      parseStderrLine('ERROR: Parser error: syntax error in file /main.scad, line 118', (error) => {
        errors.push(error);
      });

      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual({
        message: 'syntax error',
        location: { fileName: 'main.scad', startLineNumber: 118, startColumn: 0 },
        type: 'compilation',
      });
    });

    it('should strip leading slashes from filenames', () => {
      const errors: KernelError[] = [];
      parseStderrLine('ERROR: Parser error: syntax error in file /path/to/file.scad, line 10', (error) => {
        errors.push(error);
      });

      expect(errors).toHaveLength(1);
      expect(errors[0]?.location?.fileName).toBe('path/to/file.scad');
    });

    it('should parse += syntax errors (compound assignment not supported)', () => {
      // Real error from OpenSCAD when using += operator
      const errors: KernelError[] = [];
      parseStderrLine('ERROR: Parser error: syntax error in file /main.scad, line 118', (error) => {
        errors.push(error);
      });

      expect(errors).toHaveLength(1);
      expect(errors[0]?.location?.startLineNumber).toBe(118);
    });

    it('should parse errors with different file paths', () => {
      const errors: KernelError[] = [];
      parseStderrLine('ERROR: Parser error: unexpected token in file lib/utils.scad, line 42', (error) => {
        errors.push(error);
      });

      expect(errors).toHaveLength(1);
      expect(errors[0]?.location?.fileName).toBe('lib/utils.scad');
      expect(errors[0]?.location?.startLineNumber).toBe(42);
    });
  });

  describe('Warnings', () => {
    it('should parse warning format: WARNING: message in file X, line Y', () => {
      const errors: KernelError[] = [];
      parseStderrLine('WARNING: Undefined variable in file model.scad, line 42', (error) => {
        errors.push(error);
      });

      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toBe('Undefined variable');
      expect(errors[0]?.location?.fileName).toBe('model.scad');
      expect(errors[0]?.location?.startLineNumber).toBe(42);
      expect(errors[0]?.type).toBe('compilation');
    });

    it('should parse warnings with trailing period', () => {
      const errors: KernelError[] = [];
      parseStderrLine('WARNING: Variable shadowing, in file test.scad, line 10.', (error) => {
        errors.push(error);
      });

      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toBe('Variable shadowing');
    });
  });

  describe('Non-matching messages', () => {
    it('should not call addError for ECHO statements', () => {
      const errors: KernelError[] = [];
      parseStderrLine('ECHO: "Hello World"', (error) => {
        errors.push(error);
      });

      expect(errors).toHaveLength(0);
    });

    it('should not call addError for "Can\'t parse file" messages', () => {
      const errors: KernelError[] = [];
      parseStderrLine("Can't parse file 'main.scad'!", (error) => {
        errors.push(error);
      });

      expect(errors).toHaveLength(0);
    });

    it('should not call addError for empty strings', () => {
      const errors: KernelError[] = [];
      parseStderrLine('', (error) => {
        errors.push(error);
      });

      expect(errors).toHaveLength(0);
    });

    it('should not call addError for generic info messages', () => {
      const errors: KernelError[] = [];
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

