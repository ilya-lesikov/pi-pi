import Foundation

protocol Drawable {
    func draw()
    var area: Double { get }
}

public class Shape: Drawable {
    var name: String
    
    init(name: String) {
        self.name = name
    }
    
    func draw() {
        print("Drawing \(name)")
    }
    
    var area: Double {
        return 0.0
    }
}

struct Point {
    var x: Double
    var y: Double
    
    func distance(to other: Point) -> Double {
        let dx = x - other.x
        let dy = y - other.y
        return (dx * dx + dy * dy).squareRoot()
    }
}

enum Direction {
    case north
    case south
    case east
    case west
    
    func opposite() -> Direction {
        switch self {
        case .north: return .south
        case .south: return .north
        case .east: return .west
        case .west: return .east
        }
    }
}

extension Shape {
    func describe() -> String {
        return "Shape: \(name)"
    }
}

func globalHelper(value: Int) -> Bool {
    return value > 0
}
