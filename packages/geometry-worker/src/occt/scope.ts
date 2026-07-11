/**
 * RAII-style disposer for emscripten-bound OCCT objects.
 *
 * Every `new oc.Something()` allocates on the WASM heap and must be freed
 * with `.delete()` — JS GC does NOT reclaim it. Wrapping temporaries in a
 * Scope keeps kernel code leak-free without try/finally noise at every call.
 */
export interface Deletable {
  delete(): void;
}

export class Scope {
  private objects: Deletable[] = [];

  add<T extends Deletable>(obj: T): T {
    this.objects.push(obj);
    return obj;
  }

  dispose(): void {
    // free in reverse allocation order (dependents before dependencies)
    for (let i = this.objects.length - 1; i >= 0; i--) {
      try {
        this.objects[i]!.delete();
      } catch {
        // ignore double-frees from aliased handles
      }
    }
    this.objects.length = 0;
  }
}
