package com.mobilevision.android.writing

internal class WritingHistory<T>(private val items: MutableList<T>) {
    private sealed interface Change<T> {
        data class Added<T>(val item: T) : Change<T>
        data class Cleared<T>(val items: List<T>) : Change<T>
    }
    private val past = ArrayDeque<Change<T>>()
    private val future = ArrayDeque<Change<T>>()
    val canUndo get() = past.isNotEmpty()
    val canRedo get() = future.isNotEmpty()

    fun add(item: T) { items.add(item); past.addLast(Change.Added(item)); future.clear() }
    fun clear() { if (items.isEmpty()) return; past.addLast(Change.Cleared(items.toList())); items.clear(); future.clear() }
    fun undo() {
        val change = past.removeLastOrNull() ?: return
        when (change) { is Change.Added -> items.removeAt(items.lastIndex); is Change.Cleared -> items.addAll(change.items) }
        future.addLast(change)
    }
    fun redo() {
        val change = future.removeLastOrNull() ?: return
        when (change) { is Change.Added -> items.add(change.item); is Change.Cleared -> items.clear() }
        past.addLast(change)
    }
    fun restoreUndoForLoadedItems() { items.forEach { past.addLast(Change.Added(it)) } }
}
