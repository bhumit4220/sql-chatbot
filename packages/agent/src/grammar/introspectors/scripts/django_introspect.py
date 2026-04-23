#!/usr/bin/env python3
"""Django models.py AST walker. Stdlib only.

Usage: python3 django_introspect.py <path-to-django-project>
Outputs JSON to stdout shaped for sql-chatbot grammar registry.
"""
import ast
import json
import os
import sys


def walk_models_file(path):
    with open(path, 'r') as f:
        tree = ast.parse(f.read())
    entities = []
    module_choices = {}

    # First pass: top-level CHOICES constants
    for node in tree.body:
        if isinstance(node, ast.Assign) and isinstance(node.value, (ast.List, ast.Tuple)):
            for t in node.targets:
                if isinstance(t, ast.Name) and t.id.endswith('_CHOICES'):
                    module_choices[t.id] = extract_choices(node.value)

    # Second pass: classes inheriting from models.Model
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and is_django_model(node):
            entities.append(extract_entity(node, module_choices, path))
    return entities


def is_django_model(class_node):
    for base in class_node.bases:
        if isinstance(base, ast.Attribute) and base.attr == 'Model':
            return True
    return False


def extract_choices(list_node):
    result = {}
    for elt in list_node.elts:
        if isinstance(elt, ast.Tuple) and len(elt.elts) >= 2:
            k = elt.elts[0]
            v = elt.elts[1]
            key = k.value if isinstance(k, ast.Constant) else None
            label = v.value if isinstance(v, ast.Constant) else None
            if key is not None and label is not None:
                result[str(label)] = key
    return result


def extract_entity(class_node, module_choices, source_path):
    entity = {
        'name': class_node.name.lower(),
        'class': class_node.name,
        'table': None,
        'fields': {},
        'fks': [],
    }
    for child in class_node.body:
        if isinstance(child, ast.ClassDef) and child.name == 'Meta':
            for m in child.body:
                if isinstance(m, ast.Assign):
                    for t in m.targets:
                        if isinstance(t, ast.Name) and t.id == 'db_table':
                            if isinstance(m.value, ast.Constant):
                                entity['table'] = m.value.value
        elif isinstance(child, ast.Assign) and len(child.targets) == 1 and isinstance(child.targets[0], ast.Name):
            field_name = child.targets[0].id
            if isinstance(child.value, ast.Call):
                entity['fields'][field_name] = extract_field(child.value, module_choices)
                if field_type_name(child.value) == 'ForeignKey':
                    target = fk_target(child.value)
                    if target:
                        entity['fks'].append({'field': field_name, 'target': target})
    if not entity['table']:
        entity['table'] = pluralize_snake(class_node.name)
    return entity


def field_type_name(call_node):
    if isinstance(call_node.func, ast.Attribute):
        return call_node.func.attr
    return ''


def extract_field(call_node, module_choices):
    t = field_type_name(call_node)
    type_map = {
        'IntegerField': 'int', 'BigIntegerField': 'int', 'AutoField': 'int',
        'CharField': 'text', 'TextField': 'text', 'EmailField': 'text',
        'BooleanField': 'bool',
        'DateTimeField': 'timestamp', 'DateField': 'timestamp',
        'DecimalField': 'decimal', 'FloatField': 'decimal',
        'JSONField': 'jsonb', 'UUIDField': 'uuid',
        'ForeignKey': 'int',
    }
    enum_values = None
    for kw in call_node.keywords:
        if kw.arg == 'choices':
            if isinstance(kw.value, ast.Name) and kw.value.id in module_choices:
                enum_values = module_choices[kw.value.id]
            elif isinstance(kw.value, (ast.List, ast.Tuple)):
                enum_values = extract_choices(kw.value)
    return {
        'type': 'enum' if enum_values else type_map.get(t, 'text'),
        'enum_values': enum_values,
    }


def fk_target(call_node):
    if not call_node.args:
        return None
    a = call_node.args[0]
    if isinstance(a, ast.Name):
        return a.id
    if isinstance(a, ast.Constant) and isinstance(a.value, str):
        return a.value
    return None


def pluralize_snake(class_name):
    s = class_name[0].lower()
    for c in class_name[1:]:
        s += ('_' + c.lower()) if c.isupper() else c
    if s.endswith('y'):
        return s[:-1] + 'ies'
    if s.endswith('s'):
        return s + 'es'
    return s + 's'


def walk_project(root):
    all_entities = []
    for dirpath, _, files in os.walk(root):
        for f in files:
            if f == 'models.py':
                try:
                    all_entities.extend(walk_models_file(os.path.join(dirpath, f)))
                except Exception as e:
                    sys.stderr.write(f"skipping {dirpath}/{f}: {e}\n")
    return all_entities


def main():
    if len(sys.argv) != 2:
        print('usage: django_introspect.py <project-root>', file=sys.stderr)
        sys.exit(2)
    entities = walk_project(sys.argv[1])
    json.dump({'entities': entities}, sys.stdout)


if __name__ == '__main__':
    main()
