import * as JsonPointer from './jsonPointer';
import * as utils from './utils';
import { SchemaId } from './schemaid';
import { WriteProcessor } from './writeProcessor';

export class TypeDefenition {
    private id: SchemaId;
    private target: JsonSchema;
    private isInnerType = false;

    constructor(private schema: JsonSchema, private path: string[]) {
        this.target = JsonPointer.get(schema, path);
        if (!this.target || !this.target.id) {
            this.id = null;
        } else {
            const baseId = this.target.id;
            const parentsId: string[] = [];
            for (let i = path.length - 1; i >= 0; i--) {
                const parent = JsonPointer.get(schema, path.slice(0, i));
                if (parent && parent.id) {
                    parentsId.push(parent.id);
                }
            }
            this.id = new SchemaId(baseId, parentsId);
        }
    }

    get schemaId(): SchemaId {
        return this.id;
    }
    get rootSchema(): JsonSchema {
        return this.schema;
    }
    get targetSchema(): JsonSchema {
        return this.target;
    }

    public doProcess(process: WriteProcessor): void {
        this.generateType(process, this.schema);
    }


    private searchRef(process: WriteProcessor, ref: SchemaId): TypeDefenition {
        if (!(ref instanceof SchemaId)) {
            throw new Error('Invalid ref id: ' + ref);
        }
        const type = process.referenceResolve(this.schema, ref);
        if (type == null) {
            throw new Error('Target reference is not found: ' + ref.getAbsoluteId());
        }
        return type;
    }
    private getTypename(id: SchemaId | string): string[] {
        let sid = (id instanceof SchemaId) ? id : new SchemaId(id, []);
        const result = sid.getTypeNames();
        const myId = this.schemaId;
        if (myId) {
            const baseType = myId.getTypeNames();
            const isSameLength = result.length === baseType.length;
            for (let name of baseType) {
                if (result[0] === name) {
                    result.shift();
                } else {
                    break;
                }
            }
            if (result.length === 0) {
                return !this.isInnerType && isSameLength ? ['this'] : [sid.getInterfaceName()];
            }
        }
        return result;
    }

    private generateType(process: WriteProcessor, type: JsonSchema): void {
        if (type.type === undefined) {
            type.type = 'object';
        }
        if (type.type !== 'object' && type.type !== 'any' && type.type !== 'array') {
            throw new Error('unknown type: ' + type.type);
        }

        process.outputJSDoc(type.description);
        if (type.type === 'array') {
            this.generateTypeCollection(process, type);
        } else {
            this.generateTypeModel(process, type);
        }
    }

    private generateTypeModel(process: WriteProcessor, type: JsonSchema) {
        const name = this.id.getInterfaceName();
        process.output('export interface ').outputType(name).outputLine(' {');
        process.increaseIndent();

        if (type.type === 'any') {
            // TODO this is not permitted property access by dot.
            process.outputLine('[name: string]: any; // any');
        }

        Object.keys(type.properties || {}).forEach((propertyName) => {
            const property = type.properties[propertyName];
            process.outputJSDoc(property.description);
            this.generatePropertyName(process, propertyName, type);
            this.generateTypeProperty(process, property);
        });

        process.decreaseIndent();
        process.outputLine('}');
    }

    private generateTypeCollection(process: WriteProcessor, type: JsonSchema) {
        const name = this.id.getInterfaceName();
        process.output('export interface ').outputType(name).output(' extends Array<');
        if (type.items.$ref) {
            const itemsRef = this.searchRef(process, type.items.$ref);
            this.generateTypePropertyNamedType(process, this.getTypename(itemsRef.id), false, type.items, false);
        } else {
            this.generateTypeProperty(process, type.items, false);
        }
        process.outputLine('> {');
        process.outputLine('}');
    }

    private generatePropertyName(process: WriteProcessor, propertyName: string, property: JsonSchema): void {
        if (propertyName) {
            const optionalProperty = !property.required || property.required.indexOf(propertyName) < 0;
            process.outputKey(propertyName, optionalProperty).output(': ');
        }
    }
    private generateTypeProperty(process: WriteProcessor, property: JsonSchema, terminate = true): void {
        if (!property)
            return;
        if (property.allOf) {
            const schema: any = {};
            property.allOf.forEach((p) => {
                if (p.$ref) {
                    p = this.searchRef(process, <any>p.$ref).targetSchema;
                }
                utils.mergeSchema(schema, p);
            });
            this.generateTypeProperty(process, schema, terminate);
            return;
        }
        ['oneOf', 'not'].forEach((keyword) => {
            const schema: any = property;
            if (schema[keyword]) {
                console.error(property);
                throw new Error('unsupported property: ' + keyword);
            }
        });
        if (property.$ref) {
            const ref = this.searchRef(process, <any>property.$ref);
            if (ref.id) {
                this.generateTypePropertyNamedType(process, this.getTypename(ref.id), false, ref.targetSchema, terminate);
            } else {
                this.generateTypeProperty(process, ref.targetSchema, terminate);
            }
            return;
        }
        if (property.anyOf) {
            const anyOf = property.anyOf;
            if (!terminate) {
                process.output('(');
            }
            anyOf.forEach((type: JsonSchema, index: number) => {
                const isLast = index === anyOf.length - 1;
                if (type.id) {
                    this.generateTypePropertyNamedType(process, this.getTypename(type.id), false, type, isLast && terminate);
                } else {
                    this.generateTypeProperty(process, type, isLast && terminate);
                }
                if (!isLast) {
                  process.output(' | ');
                }
            });
            if (!terminate) {
                process.output(')');
            }
            return;
        }
        if (property.enum) {
            if (!terminate) {
                process.output('(');
            }
            process.output(property.enum.map(s => '"' + s + '"').join(' | '));
            if (!terminate) {
                process.output(')');
            } else {
                process.outputLine(';');
            }
            return;
        }

        const type = property.type;
        if (type == null) {
            this.generateTypePropertyNamedType(process, 'any', true, property, terminate);
        } else if (typeof type === 'string') {
            this.generateTypeName(process, type, property, terminate);
        } else {
            const types = utils.reduceTypes(type);
            if (!terminate && types.length > 1) {
                process.output('(');
            }
            types.forEach((t: string, index: number) => {
                const isLast = index === types.length - 1;
                this.generateTypeName(process, t, property, terminate);
                if (!isLast) {
                  process.output(' | ');
                }
            });
            if (!terminate && types.length > 1) {
                process.output(')');
            }
        }
    }

    private generateTypeName(process: WriteProcessor, type: string, property: JsonSchema, terminate: boolean): void {
        const tsType = utils.toTSType(type, property);
        if (tsType) {
            this.generateTypePropertyNamedType(process, tsType, true, property, terminate);
            return;
        }
        if (type === 'object') {
            process.outputLine('{');
            process.increaseIndent();
            this.isInnerType = true;
            if (property.additionalProperties) {
                process.output('[name: string]: ');
                this.generateTypeProperty(process, property.additionalProperties, true);
            }
            if (property.properties) {
                Object.keys(property.properties).forEach((propertyName) => {
                    const nextProperty = property.properties[propertyName];
                    this.generatePropertyName(process, propertyName, property);
                    this.generateTypeProperty(process, nextProperty);
                });
            }
            this.isInnerType = false;
            process.decreaseIndent();
            process.output('}');
            if (terminate) {
                process.outputLine(';');
            }

        } else if (type === 'array') {
            this.generateTypeProperty(process, property.items == null ? {} : property.items, false);
            process.output('[]');
            if (terminate) {
                process.outputLine(';');
            }

        } else {
            console.error(property);
            throw new Error('unknown type: ' + property.type);
        }
    }

    private generateTypePropertyNamedType(process: WriteProcessor, typeName: string | string[], primitiveType: boolean, property: JsonSchema, terminate = true) {
        if (Array.isArray(typeName)) {
            typeName.forEach((type: string, index: number) => {
                const isLast = index === typeName.length - 1;
                process.outputType(type, primitiveType);
                if (!isLast) {
                    process.output('.');
                }
            });
        } else {
            process.outputType(typeName, primitiveType);
        }
        if (terminate) {
            process.output(';');
            if (property.format) {
                process.output(' // ').output(property.format);
            }
            process.outputLine();
        } else {
            if (property.format) {
                process.output(' /* ').output(property.format).output(' */ ');
            }
        }
    }
}
